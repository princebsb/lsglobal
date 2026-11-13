import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Query, Res, StreamableFile } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  ASSEMBLY_STATUS_LABELS,
  BALLOT_STATUS_LABELS,
  CONVOCATION_LEGAL_NOTICE,
  CONVOCATION_STATUS_LABELS,
  DELIVERY_STATUS_LABELS,
  OUTCOME_LABELS,
  type BallotStatus,
  type RuleEvaluation,
  type TallyResult,
} from '@lsg/shared';
import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { AuditService } from '../../audit/audit.service';
import { AuthzService } from '../../authz/authz.service';
import { CryptoService } from '../../common/crypto.service';
import { Ctx, RequirePermission, TenantScoped, conflict, notFound, type ReqCtx } from '../../common/http';
import { dbc } from '../../common/scope';
import { DbService, type Q } from '../../db/db.service';
import { AssembliesService, type AssemblyRow } from '../assemblies/assemblies.service';
import { QuorumService } from '../assemblies/quorum.service';
import { VotingService } from '../voting/voting.service';

// ---------------------------------------------------------------------------
// Geração de arquivos (CSV/XLSX) a partir de um documento tabular
// ---------------------------------------------------------------------------

type ReportFormat = 'csv' | 'xlsx';
type Cell = string | number | null | undefined;

interface ReportDoc {
  /** Nome da planilha (máx. 31 caracteres no Excel). */
  sheet: string;
  title: string;
  /** Cabeçalho do relatório: pares rótulo/valor. */
  meta: [string, Cell][];
  columns: { header: string; key: string; width?: number }[];
  rows: Record<string, Cell>[];
}

interface ReportFile {
  buffer: Buffer;
  sha256: string;
  fileName: string;
  contentType: string;
}

const CONTENT_TYPES: Record<ReportFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function parseFormat(v: unknown): ReportFormat {
  const f = String(v ?? 'csv').trim().toLowerCase();
  if (f !== 'csv' && f !== 'xlsx') throw new BadRequestException('Formato inválido: use csv ou xlsx');
  return f;
}

/** Nome de arquivo seguro (ASCII) para o cabeçalho Content-Disposition. */
function safeName(base: string, format: ReportFormat): string {
  const s = base
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 100);
  return `${s || 'relatorio'}.${format}`;
}

function csvCell(v: Cell): string {
  let s = v === null || v === undefined ? '' : String(v);
  // Neutraliza injeção de fórmulas ao abrir no Excel/LibreOffice.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV com BOM UTF-8 e ";" como separador (padrão do Excel em pt-BR). */
function toCsv(doc: ReportDoc): Buffer {
  const lines: string[] = [csvCell(doc.title)];
  for (const [k, v] of doc.meta) lines.push(`${csvCell(k)};${csvCell(v)}`);
  lines.push('');
  lines.push(doc.columns.map((c) => csvCell(c.header)).join(';'));
  for (const r of doc.rows) lines.push(doc.columns.map((c) => csvCell(r[c.key])).join(';'));
  return Buffer.from(`﻿${lines.join('\r\n')}\r\n`, 'utf8');
}

async function toXlsx(doc: ReportDoc): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LS Global Assembleias';
  wb.created = new Date();
  const ws = wb.addWorksheet(doc.sheet.slice(0, 31));
  ws.addRow([doc.title]).font = { bold: true, size: 14 };
  for (const [k, v] of doc.meta) {
    const r = ws.addRow([k, v ?? '']);
    r.getCell(1).font = { bold: true };
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  }
  ws.addRow([]);
  const header = ws.addRow(doc.columns.map((c) => c.header));
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
    cell.border = { bottom: { style: 'thin' } };
  });
  for (const r of doc.rows) ws.addRow(doc.columns.map((c) => r[c.key] ?? ''));
  ws.columns = doc.columns.map((c, i) => ({ width: Math.max(c.width ?? 18, i === 0 ? 30 : 0) }));
  ws.views = [{ state: 'frozen', ySplit: header.number }];
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

function fmtDate(v: Date | string | null | undefined, tz: string): string {
  if (!v) return '';
  return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium', timeZone: tz }).format(new Date(v));
}

const yesNo = (b: boolean | null | undefined) => (b ? 'Sim' : 'Não');

const BALLOT_TYPE_LABELS: Record<string, string> = {
  yes_no: 'Sim / Não',
  single_choice: 'Escolha única',
  multiple_choice: 'Múltipla escolha',
  election: 'Eleição',
};
const OPTION_KIND_LABELS: Record<string, string> = {
  regular: 'Opção',
  yes: 'Sim',
  no: 'Não',
  abstention: 'Abstenção',
  blank: 'Em branco',
  null: 'Nulo',
};
const RELATION_LABELS: Record<string, string> = {
  proprietario: 'Proprietário',
  coproprietario: 'Coproprietário',
  promitente_comprador: 'Promitente comprador',
  usufrutuario: 'Usufrutuário',
  representante_legal: 'Representante legal',
};
const COUNTING_LABELS: Record<string, string> = { unit: 'Por unidade', ideal_fraction: 'Por fração ideal' };

function describeEvaluation(e: RuleEvaluation | null | undefined): string {
  if (!e) return 'Não aplicável';
  return `${e.met ? 'Atingido' : 'Não atingido'} — obtido ${e.achieved} (${e.achievedPercent}%), exigido ${e.required} (${e.requiredPercent}%) sobre base ${e.base}`;
}

interface RuleSnap {
  code: string;
  version: number;
  name: string;
  legalBasis: string;
}

const describeRuleSnap = (r: RuleSnap | null | undefined) => (r ? `${r.code} v${r.version} — ${r.name} (${r.legalBasis})` : 'Não definida');

// ---------------------------------------------------------------------------
// Controlador
// ---------------------------------------------------------------------------

/**
 * Relatórios exportáveis (CSV/XLSX). Cada exportação é registrada na auditoria, na mesma transação
 * da leitura, com o SHA-256 do arquivo, que também é devolvido no cabeçalho X-Content-SHA256.
 */
@ApiTags('Relatórios')
@ApiBearerAuth()
@TenantScoped()
@Controller()
export class ReportsController {
  constructor(
    private readonly db: DbService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly crypto: CryptoService,
    private readonly assemblies: AssembliesService,
    private readonly quorum: QuorumService,
    private readonly voting: VotingService,
  ) {}

  /** Lista de presença: credenciamentos (ativos e revogados) e quórum de instalação no momento da exportação. */
  @Get('assemblies/:id/reports/attendance')
  @RequirePermission('reports.export')
  async attendance(
    @Ctx() ctx: ReqCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const format = parseFormat(query.format);
    const file = await this.db.tx(dbc(ctx), async (q) => {
      const a = await this.assemblies.load(q, id);
      this.authz.require(ctx, 'reports.export', a.condominium_id);
      const canSeeNames = this.authz.has(ctx, 'assembly.accredit', a.condominium_id) || this.authz.has(ctx, 'assembly.conduct', a.condominium_id);
      const condo = await this.condoName(q, a);
      const live = await this.quorum.live(q, a);
      const rows = await q.rows<{
        unit: string; ideal_fraction: string; voting_status: string; person_name: string; basis: string; poa_id: string | null;
        mode: string; accredited_at: Date; accredited_by_name: string | null; revoked_at: Date | null; revoke_reason: string | null;
      }>(
        `select concat_ws(' - ', b.name, u.identifier) as unit, u.ideal_fraction::text as ideal_fraction, u.voting_status,
                ${canSeeNames ? 'p.name' : `left(p.name, 1) || '***'`} as person_name, x.basis, x.poa_id, x.mode,
                x.accredited_at, ub.full_name as accredited_by_name, x.revoked_at, x.revoke_reason
           from accreditations x join units u on u.id = x.unit_id left join buildings b on b.id = u.building_id
           join people p on p.id = x.person_id left join users ub on ub.id = x.accredited_by
          where x.assembly_id = $1
          order by b.name nulls first, u.identifier, x.accredited_at`,
        [id],
      );
      const tz = a.timezone;
      const doc: ReportDoc = {
        sheet: 'Presença',
        title: `Lista de presença — ${a.code} — ${a.title}`,
        meta: [
          ['Condomínio', condo],
          ['Assembleia', `${a.code} — ${a.title}`],
          ['Situação', ASSEMBLY_STATUS_LABELS[a.status] ?? a.status],
          ['1ª convocação', fmtDate(a.first_call_at, tz)],
          ['2ª convocação', fmtDate(a.second_call_at, tz)],
          ['Base eleitoral (unidades aptas)', `${live.electorate.units} unidade(s) — fração ${live.electorate.fraction}`],
          ['Presentes (credenciamentos ativos)', `${live.present.units} unidade(s) — fração ${live.present.fraction}`],
          ['Presencial / remoto / por procuração', `${live.present.presencial} / ${live.present.remoto} / ${live.present.byPoa}`],
          ['Quórum de instalação — 1ª convocação', live.firstCall ? `${live.firstCall.rule.code} v${live.firstCall.rule.version}: ${describeEvaluation(live.firstCall.evaluation)}` : 'Regra não homologada'],
          ['Quórum de instalação — 2ª convocação', live.secondCall ? `${live.secondCall.rule.code} v${live.secondCall.rule.version}: ${describeEvaluation(live.secondCall.evaluation)}` : 'Regra não homologada'],
          ['Pendências', live.issues.map((i) => `[${i.severity === 'blocking' ? 'bloqueante' : 'alerta'}] ${i.message}`).join(' | ') || 'Nenhuma'],
          ['Gerado em', `${fmtDate(new Date(), tz)} (${tz})`],
          ['Gerado por', ctx.auth.fullName],
        ],
        columns: [
          { header: 'Unidade', key: 'unit', width: 22 },
          { header: 'Fração ideal', key: 'fraction', width: 16 },
          { header: 'Direito de voto', key: 'voting', width: 16 },
          { header: 'Representante', key: 'person', width: 30 },
          { header: 'Base', key: 'basis', width: 14 },
          { header: 'Modo', key: 'mode', width: 12 },
          { header: 'Credenciado em', key: 'at', width: 22 },
          { header: 'Credenciado por', key: 'by', width: 26 },
          { header: 'Situação', key: 'status', width: 12 },
          { header: 'Revogado em', key: 'revokedAt', width: 22 },
          { header: 'Motivo da revogação', key: 'revokeReason', width: 30 },
        ],
        rows: rows.map((r) => ({
          unit: r.unit,
          fraction: r.ideal_fraction,
          voting: r.voting_status === 'eligible' ? 'Apta' : 'Restrita',
          person: r.person_name,
          basis: r.basis === 'procuracao' ? 'Procuração' : 'Titular',
          mode: r.mode === 'remoto' ? 'Remoto' : 'Presencial',
          at: fmtDate(r.accredited_at, tz),
          by: r.accredited_by_name ?? '',
          status: r.revoked_at ? 'Revogado' : 'Ativo',
          revokedAt: fmtDate(r.revoked_at, tz),
          revokeReason: r.revoke_reason ?? '',
        })),
      };
      const f = await this.render(doc, format, `presenca-${a.code}`);
      await this.audit.record(q, ctx, {
        action: 'report.exported', resourceType: 'assembly', resourceId: a.id, assemblyId: a.id,
        metadata: { report: 'attendance', format, fileName: f.fileName, sha256: f.sha256, rows: doc.rows.length },
      });
      return f;
    });
    return this.deliver(res, file);
  }

  /** Resultado oficial da votação: a apuração persistida (declarada ou, para a mesa, a mais recente). */
  @Get('ballots/:id/reports/result')
  @RequirePermission('reports.export')
  async result(
    @Ctx() ctx: ReqCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const format = parseFormat(query.format);
    const file = await this.db.tx(dbc(ctx), async (q) => {
      const b = await this.voting.loadBallot(q, id);
      const a = await this.assemblies.load(q, b.assembly_id);
      this.authz.require(ctx, 'reports.export', a.condominium_id);
      if (!['tallied', 'declared'].includes(b.status)) throw conflict('A votação ainda não foi apurada', 'NOT_TALLIED');
      // Mesma regra de visibilidade do detalhe da votação: apuração não declarada só para a mesa.
      if (b.status === 'declared') this.authz.require(ctx, 'results.view', a.condominium_id);
      else this.authz.require(ctx, 'assembly.conduct', a.condominium_id);
      const r = await q.maybe<{
        id: string; computed_at: Date; outcome: string; declarable: boolean; tally: TallyResult;
        rule_snapshot: { approval: RuleSnap | null; presence: RuleSnap | null }; result_hash: string; votes_head_hash: string | null;
      }>(
        `select id, computed_at, outcome, declarable, tally, rule_snapshot, result_hash, votes_head_hash
           from ballot_results where ballot_id = $1 ${b.status === 'declared' ? 'and id = $2' : 'order by computed_at desc limit 1'}`,
        b.status === 'declared' ? [id, b.declared_result_id] : [id],
      );
      if (!r) throw notFound('Apuração');
      const condo = await this.condoName(q, a);
      const declared = await q.maybe<{ declared_at: Date | null; declared_by_name: string | null }>(
        `select b.declared_at, u.full_name as declared_by_name from ballots b left join users u on u.id = b.declared_by where b.id = $1`,
        [id],
      );
      const t = r.tally;
      const tz = a.timezone;
      const w = (x: { units: number; fraction: string }) => `${x.units} unidade(s) — fração ${x.fraction}`;
      const winners = new Set(t.winners);
      const doc: ReportDoc = {
        sheet: 'Resultado',
        title: `Resultado da votação — ${b.title}${b.round > 1 ? ` (rodada ${b.round})` : ''}`,
        meta: [
          ['Condomínio', condo],
          ['Assembleia', `${a.code} — ${a.title}`],
          ['Votação', `${b.title}${b.round > 1 ? ` (rodada ${b.round})` : ''}`],
          ['Pergunta', b.question],
          ['Tipo', BALLOT_TYPE_LABELS[b.ballot_type] ?? b.ballot_type],
          ['Sigilo', b.secrecy === 'secret' ? 'Sigilosa' : 'Nominal'],
          ['Situação', BALLOT_STATUS_LABELS[b.status as BallotStatus] ?? b.status],
          ['Resultado', OUTCOME_LABELS[r.outcome] ?? r.outcome],
          ['Declarável', yesNo(r.declarable)],
          ['Abertura', fmtDate(b.opened_at, tz)],
          ['Encerramento', fmtDate(b.closed_at, tz)],
          ['Apurado em', fmtDate(r.computed_at, tz)],
          ['Declarado em', b.status === 'declared' ? `${fmtDate(declared?.declared_at, tz)}${declared?.declared_by_name ? ` por ${declared.declared_by_name}` : ''}` : 'Não declarado'],
          ['Regra de aprovação', describeRuleSnap(r.rule_snapshot?.approval)],
          ['Regra de presença', describeRuleSnap(r.rule_snapshot?.presence)],
          ['Unidade de contagem', COUNTING_LABELS[t.countingUnit] ?? t.countingUnit],
          ['Base eleitoral', w(t.totals.electorate)],
          ['Presentes', w(t.totals.present)],
          ['Votos computados', w(t.totals.votesCast)],
          ['Votos válidos', w(t.totals.validVotes)],
          ['Abstenções / brancos / nulos', w(t.totals.nonValid)],
          ['Presentes que não votaram', w(t.totals.pending)],
          ['Quórum de presença', describeEvaluation(t.presence)],
          ['Quórum de aprovação', describeEvaluation(t.approval)],
          ['Vencedor(es)', t.options.filter((o) => winners.has(o.id)).map((o) => o.label).join(', ') || 'Nenhum'],
          ['Pendências', t.issues.map((i) => `[${i.severity === 'blocking' ? 'bloqueante' : 'alerta'}] ${i.message}`).join(' | ') || 'Nenhuma'],
          ['Hash SHA-256 do resultado', r.result_hash],
          ['Hash do último voto (cadeia)', r.votes_head_hash ?? (b.secrecy === 'secret' ? 'Não aplicável (votação sigilosa)' : '')],
          ['Gerado em', `${fmtDate(new Date(), tz)} (${tz})`],
          ['Gerado por', ctx.auth.fullName],
        ],
        columns: [
          { header: 'Opção', key: 'label', width: 32 },
          { header: 'Tipo', key: 'kind', width: 14 },
          { header: 'Unidades', key: 'units', width: 12 },
          { header: 'Fração ideal', key: 'fraction', width: 16 },
          { header: '% sobre a base', key: 'percent', width: 16 },
          { header: 'Vencedora', key: 'winner', width: 12 },
        ],
        rows: t.options.map((o) => ({
          label: o.label,
          kind: OPTION_KIND_LABELS[o.kind] ?? o.kind,
          units: o.units,
          fraction: o.fraction,
          percent: o.percentOfBase,
          winner: yesNo(winners.has(o.id)),
        })),
      };
      const f = await this.render(doc, format, `resultado-${a.code}-${b.title}${b.round > 1 ? `-r${b.round}` : ''}`);
      await this.audit.record(q, ctx, {
        action: 'report.exported', resourceType: 'ballot', resourceId: b.id, assemblyId: a.id,
        metadata: { report: 'result', format, fileName: f.fileName, sha256: f.sha256, resultId: r.id, resultHash: r.result_hash },
      });
      return f;
    });
    return this.deliver(res, file);
  }

  /** Comprovante de convocação: edital publicado (hash do conteúdo) e situação de envio/abertura por destinatário. */
  @Get('convocations/:id/reports/receipt')
  @RequirePermission('reports.export')
  async convocationReceipt(
    @Ctx() ctx: ReqCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const format = parseFormat(query.format);
    const file = await this.db.tx(dbc(ctx), async (q) => {
      const c = await q.maybe<{
        id: string; assembly_id: string; version: number; status: string; subject: string; content_sha256: string | null;
        published_at: Date | null; published_by_name: string | null; rectification_reason: string | null;
      }>(
        `select c.id, c.assembly_id, c.version, c.status, c.subject, c.content_sha256, c.published_at,
                pu.full_name as published_by_name, c.rectification_reason
           from convocations c left join users pu on pu.id = c.published_by where c.id = $1`,
        [id],
      );
      if (!c) throw notFound('Convocação');
      const a = await this.assemblies.load(q, c.assembly_id);
      this.authz.require(ctx, 'reports.export', a.condominium_id);
      if (c.status === 'draft') throw conflict('O edital ainda não foi publicado', 'NOT_PUBLISHED');
      const condo = await this.condoName(q, a);
      const rows = await q.rows<{
        unit: string; person_name: string; relation: string; channel: string; address_masked: string | null;
        delivery_status: string | null; attempts: number | null; last_error: string | null; sent_at: Date | null;
        provider_message_id: string | null; first_opened_at: Date | null; opens: number;
      }>(
        `select concat_ws(' - ', b.name, u.identifier) as unit, p.name as person_name, r.relation, r.channel, r.address_masked,
                d.status as delivery_status, d.attempts, d.last_error, d.sent_at, d.provider_message_id,
                (select min(e.occurred_at) from convocation_delivery_events e where e.recipient_id = r.id and e.event = 'opened') as first_opened_at,
                (select count(*)::int from convocation_delivery_events e where e.recipient_id = r.id and e.event = 'opened') as opens
           from convocation_recipients r
           join units u on u.id = r.unit_id left join buildings b on b.id = u.building_id
           join people p on p.id = r.person_id
           left join lateral (select * from convocation_deliveries d where d.recipient_id = r.id order by d.created_at desc limit 1) d on true
          where r.convocation_id = $1
          order by b.name nulls first, u.identifier, p.name`,
        [id],
      );
      const tz = a.timezone;
      const count = (pred: (r: (typeof rows)[number]) => boolean) => rows.filter(pred).length;
      const doc: ReportDoc = {
        sheet: 'Convocação',
        title: `Comprovante de convocação — ${a.code} — edital v${c.version}`,
        meta: [
          ['Condomínio', condo],
          ['Assembleia', `${a.code} — ${a.title}`],
          ['Edital', `Versão ${c.version} — ${c.subject}`],
          ['Situação do edital', CONVOCATION_STATUS_LABELS[c.status] ?? c.status],
          ['Publicado em', `${fmtDate(c.published_at, tz)}${c.published_by_name ? ` por ${c.published_by_name}` : ''}`],
          ['Motivo da retificação', c.rectification_reason ?? ''],
          ['SHA-256 do conteúdo publicado', c.content_sha256 ?? ''],
          ['Destinatários', rows.length],
          ['Enviados ao provedor', count((r) => r.delivery_status === 'sent')],
          ['Pendentes', count((r) => r.delivery_status === 'queued' || r.delivery_status === 'sending')],
          ['Falhas', count((r) => r.delivery_status === 'failed')],
          ['Sem endereço', count((r) => r.channel === 'none')],
          ['Abertos (link pessoal)', count((r) => r.opens > 0)],
          ['Aviso', CONVOCATION_LEGAL_NOTICE],
          ['Gerado em', `${fmtDate(new Date(), tz)} (${tz})`],
          ['Gerado por', ctx.auth.fullName],
        ],
        columns: [
          { header: 'Unidade', key: 'unit', width: 22 },
          { header: 'Destinatário', key: 'person', width: 30 },
          { header: 'Vínculo', key: 'relation', width: 18 },
          { header: 'Canal', key: 'channel', width: 12 },
          { header: 'Endereço (mascarado)', key: 'address', width: 28 },
          { header: 'Situação do envio', key: 'status', width: 20 },
          { header: 'Tentativas', key: 'attempts', width: 12 },
          { header: 'Enviado em', key: 'sentAt', width: 22 },
          { header: 'Identificador no provedor', key: 'providerId', width: 32 },
          { header: 'Primeira abertura', key: 'openedAt', width: 22 },
          { header: 'Aberturas', key: 'opens', width: 12 },
          { header: 'Último erro', key: 'error', width: 30 },
        ],
        rows: rows.map((r) => ({
          unit: r.unit,
          person: r.person_name,
          relation: RELATION_LABELS[r.relation] ?? r.relation,
          channel: r.channel === 'none' ? 'Nenhum' : r.channel === 'email' ? 'E-mail' : r.channel === 'whatsapp' ? 'WhatsApp' : r.channel,
          address: r.address_masked ?? '',
          status: DELIVERY_STATUS_LABELS[r.channel === 'none' ? 'none' : (r.delivery_status ?? '')] ?? r.delivery_status ?? '',
          attempts: r.attempts ?? 0,
          sentAt: fmtDate(r.sent_at, tz),
          providerId: r.provider_message_id ?? '',
          openedAt: fmtDate(r.first_opened_at, tz),
          opens: r.opens,
          error: r.last_error ?? '',
        })),
      };
      const f = await this.render(doc, format, `convocacao-${a.code}-v${c.version}`);
      await this.audit.record(q, ctx, {
        action: 'report.exported', resourceType: 'convocation', resourceId: c.id, assemblyId: a.id,
        metadata: { report: 'convocation_receipt', format, fileName: f.fileName, sha256: f.sha256, rows: doc.rows.length, contentSha256: c.content_sha256 },
      });
      return f;
    });
    return this.deliver(res, file);
  }

  // ------------------------------------------------------------------ auxiliares
  private async condoName(q: Q, a: AssemblyRow): Promise<string> {
    return (await q.one<{ name: string }>('select name from condominiums where id = $1', [a.condominium_id])).name;
  }

  private async render(doc: ReportDoc, format: ReportFormat, baseName: string): Promise<ReportFile> {
    const buffer = format === 'xlsx' ? await toXlsx(doc) : toCsv(doc);
    return { buffer, sha256: this.crypto.sha256(buffer), fileName: safeName(baseName, format), contentType: CONTENT_TYPES[format] };
  }

  private deliver(res: Response, f: ReportFile): StreamableFile {
    res.setHeader('Content-Type', f.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${f.fileName}"`);
    res.setHeader('X-Content-SHA256', f.sha256);
    res.setHeader('Cache-Control', 'no-store');
    return new StreamableFile(f.buffer, { type: f.contentType, disposition: `attachment; filename="${f.fileName}"`, length: f.buffer.length });
  }
}
