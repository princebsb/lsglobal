import { Injectable } from '@nestjs/common';
import {
  UnitImportRowSchema,
  formatFixed,
  isValidCnpj,
  isValidCpf,
  maskDocument,
  onlyDigits,
  parseFixed,
  FIXED_SCALE,
} from '@lsg/shared';
import { AuditService } from '../../audit/audit.service';
import { CryptoService } from '../../common/crypto.service';
import type { ReqCtx } from '../../common/http';
import { dbc } from '../../common/scope';
import { DbService } from '../../db/db.service';
import { CondominiumsController } from './condominiums.controller';

export interface ImportIssue {
  row: number;
  field?: string;
  message: string;
  severity: 'error' | 'warning';
}

/**
 * Importação de unidades e proprietários com validação completa antes da gravação:
 * duplicidades no arquivo e no banco, CPF/CNPJ, frações ideais e soma das frações.
 * A gravação só ocorre se não houver erros (tudo ou nada, em uma transação).
 */
@Injectable()
export class UnitImportService {
  constructor(
    private readonly db: DbService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
  ) {}

  async run(ctx: ReqCtx, condominiumId: string, rawRows: Record<string, unknown>[], dryRun: boolean) {
    return this.db.tx(dbc(ctx), async (q) => {
      await CondominiumsController.loadCondo(q, condominiumId);
      const issues: ImportIssue[] = [];
      const existingUnits = await q.rows<{ building: string | null; identifier: string; ideal_fraction: string }>(
        `select b.name as building, u.identifier, u.ideal_fraction::text
           from units u left join buildings b on b.id = u.building_id
          where u.condominium_id = $1 and u.status = 'active'`,
        [condominiumId],
      );
      const existingKeys = new Set(existingUnits.map((u) => `${(u.building ?? '').toLowerCase()}|${u.identifier.toLowerCase()}`));
      const seen = new Set<string>();
      const valid: { row: number; data: ReturnType<typeof UnitImportRowSchema.parse>; doc: string | null }[] = [];
      let fractionSum = existingUnits.reduce((s, u) => s + parseFixed(u.ideal_fraction), 0n);

      rawRows.forEach((raw, idx) => {
        const row = idx + 2; // linha 1 = cabeçalho da planilha
        const normalized = Object.fromEntries(
          Object.entries(raw).map(([k, v]) => [k.trim().toLowerCase(), typeof v === 'string' ? v.trim() : v == null ? '' : String(v)]),
        );
        const parsed = UnitImportRowSchema.safeParse(normalized);
        if (!parsed.success) {
          for (const i of parsed.error.issues) issues.push({ row, field: i.path.join('.'), message: i.message, severity: 'error' });
          return;
        }
        const d = parsed.data;
        const key = `${d.bloco.toLowerCase()}|${d.unidade.toLowerCase()}`;
        if (seen.has(key)) issues.push({ row, field: 'unidade', message: 'Unidade duplicada no arquivo', severity: 'error' });
        if (existingKeys.has(key)) issues.push({ row, field: 'unidade', message: 'Unidade já cadastrada', severity: 'error' });
        seen.add(key);
        let doc: string | null = null;
        if (d.proprietario_documento) {
          doc = onlyDigits(d.proprietario_documento);
          const ok = doc.length === 11 ? isValidCpf(doc) : doc.length === 14 ? isValidCnpj(doc) : false;
          if (!ok) issues.push({ row, field: 'proprietario_documento', message: 'CPF/CNPJ inválido', severity: 'error' });
          if (!d.proprietario_nome) issues.push({ row, field: 'proprietario_nome', message: 'Nome do proprietário obrigatório', severity: 'error' });
        } else if (d.proprietario_nome) {
          issues.push({ row, field: 'proprietario_documento', message: 'Documento do proprietário obrigatório', severity: 'error' });
        } else {
          issues.push({ row, message: 'Unidade sem proprietário informado', severity: 'warning' });
        }
        fractionSum += parseFixed(d.fracao_ideal);
        valid.push({ row, data: d, doc });
      });

      const diff = fractionSum > FIXED_SCALE ? fractionSum - FIXED_SCALE : FIXED_SCALE - fractionSum;
      if (diff !== 0n) {
        issues.push({
          row: 0,
          message: `Soma das frações ideais após a importação: ${formatFixed(fractionSum)} (esperado 1). Verifique a convenção/memorial.`,
          severity: diff > 10_000n ? 'error' : 'warning',
        });
      }

      const errors = issues.filter((i) => i.severity === 'error').length;
      const summary = { rows: rawRows.length, valid: valid.length, errors, warnings: issues.length - errors, fractionSum: formatFixed(fractionSum) };
      if (dryRun || errors > 0) return { applied: false, summary, issues };

      const buildingIds = new Map<string, string>();
      for (const b of await q.rows<{ id: string; name: string }>('select id, name from buildings where condominium_id = $1', [condominiumId])) {
        buildingIds.set(b.name.toLowerCase(), b.id);
      }
      let createdPeople = 0;
      for (const { data: d, doc } of valid) {
        let buildingId: string | null = null;
        if (d.bloco) {
          buildingId = buildingIds.get(d.bloco.toLowerCase()) ?? null;
          if (!buildingId) {
            buildingId = (await q.one<{ id: string }>(
              'insert into buildings (tenant_id, condominium_id, name) values ($1, $2, $3) returning id',
              [ctx.tenantId, condominiumId, d.bloco],
            )).id;
            buildingIds.set(d.bloco.toLowerCase(), buildingId);
          }
        }
        const unit = await q.one<{ id: string }>(
          `insert into units (tenant_id, condominium_id, building_id, identifier, kind, ideal_fraction)
           values ($1, $2, $3, $4, $5, $6) returning id`,
          [ctx.tenantId, condominiumId, buildingId, d.unidade, d.tipo, d.fracao_ideal],
        );
        if (doc) {
          const hash = this.crypto.blindIndex(doc);
          let person = await q.maybe<{ id: string }>('select id from people where document_hash = $1', [hash]);
          if (!person) {
            person = await q.one<{ id: string }>(
              `insert into people (tenant_id, kind, name, document_enc, document_hash, document_masked, email)
               values ($1, $2, $3, $4, $5, $6, $7) returning id`,
              [ctx.tenantId, doc.length === 11 ? 'pf' : 'pj', d.proprietario_nome, this.crypto.encrypt(doc), hash,
                maskDocument(doc), d.proprietario_email || null],
            );
            createdPeople++;
          }
          await q.exec(
            `insert into unit_ownerships (tenant_id, unit_id, person_id, relation, is_voting_representative)
             values ($1, $2, $3, 'proprietario', true)`,
            [ctx.tenantId, unit.id, person.id],
          );
        }
      }
      await this.audit.record(q, ctx, {
        action: 'units.imported', resourceType: 'condominium', resourceId: condominiumId,
        metadata: { ...summary, createdPeople },
      });
      return { applied: true, summary: { ...summary, createdPeople }, issues };
    });
  }
}
