/**
 * Dados de DEMONSTRAÇÃO para ambiente local. Nenhum dado pessoal real.
 * CPFs são gerados algoritmicamente (válidos no dígito verificador, sem titular real).
 * As regras "homologadas" pela seed NÃO possuem validade jurídica.
 *
 * Uso: npm run db:seed   (idempotente: não duplica se já houver dados de demonstração)
 */
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { RULE_TEMPLATES, maskDocument } from '@lsg/shared';
import { CryptoService } from '../common/crypto.service';
import { env } from '../config/env';

export const DEMO_PASSWORD = 'Demo@LSG2026';

function cpfFrom(base: number): string {
  const d = String(base).padStart(9, '0').split('').map(Number);
  const dv = (len: number) => {
    let s = 0;
    for (let i = 0; i < len; i++) s += d[i]! * (len + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  d.push(dv(9));
  d.push(dv(10));
  return d.join('');
}

export async function seed(dbName?: string, log: (m: string) => void = console.log): Promise<void> {
  const e = env();
  if (e.NODE_ENV === 'production') throw new Error('Seed de demonstração não pode ser executada em produção');
  const crypto = new CryptoService();
  const client = new Client({ connectionString: e.adminDatabaseUrlFor(dbName ?? e.dbName) });
  await client.connect();
  const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await client.query(sql, p)).rows as T[];
  const one = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await q<T>(sql, p))[0]!;
  try {
    const exists = await q(`select 1 from users where email = 'admin@lsglobal.local'`);
    if (exists.length > 0) {
      log('• dados de demonstração já existem — nada a fazer');
      return;
    }
    await client.query('begin');
    const hash = await crypto.hashPassword(DEMO_PASSWORD);
    const user = async (email: string, name: string, staff = false) =>
      (await one<{ id: string }>(
        'insert into users (email, full_name, password_hash, is_platform_staff) values ($1,$2,$3,$4) returning id',
        [email, name, hash, staff],
      )).id;
    const assign = (userId: string, role: string, tenantId: string | null, condoId: string | null = null) =>
      client.query('insert into user_role_assignments (user_id, role_code, tenant_id, condominium_id) values ($1,$2,$3,$4)', [userId, role, tenantId, condoId]);

    // ---------------- Plataforma
    const superadmin = await user('admin@lsglobal.local', 'Superadministrador LS Global', true);
    await assign(superadmin, 'platform_superadmin', null);
    const ops = await user('operacao@lsglobal.local', 'Operação LS Global', true);
    await assign(ops, 'platform_operations', null);

    // ---------------- Cliente A — administradora
    const tA = (await one<{ id: string }>(
      `insert into tenants (name, kind, document) values ('Administradora Horizonte (Demo)', 'administradora', '11222333000181') returning id`,
    )).id;
    const gestor = await user('gestor@horizonte.demo', 'Gestora Horizonte');
    await assign(gestor, 'tenant_admin', tA);

    const condo = (await one<{ id: string }>(
      `insert into condominiums (tenant_id, name, type, legal_regime, address, settings)
       values ($1, 'Residencial Jardim das Acácias', 'multiplas_torres', 'condominio_edilicio',
               '{"street":"Rua das Acácias","number":"100","city":"São Paulo","state":"SP"}', '{"maxUnitsPerAttorney":3}') returning id`,
      [tA],
    )).id;
    const torreA = (await one<{ id: string }>(`insert into buildings (tenant_id, condominium_id, name, kind) values ($1,$2,'Torre A','torre') returning id`, [tA, condo])).id;
    const torreB = (await one<{ id: string }>(`insert into buildings (tenant_id, condominium_id, name, kind) values ($1,$2,'Torre B','torre') returning id`, [tA, condo])).id;

    // 12 unidades: 4 coberturas (0,1) + 8 tipo (0,075) = 1,0
    const units: { id: string; label: string }[] = [];
    for (const [bId, bName] of [[torreA, 'A'], [torreB, 'B']] as const) {
      const idents = ['COB-1', 'COB-2', '301', '401', '501', '601'];
      for (let i = 1; i <= 6; i++) {
        const ident = idents[i - 1]!;
        const fraction = i <= 2 ? '0.1' : '0.075';
        const id = (await one<{ id: string }>(
          `insert into units (tenant_id, condominium_id, building_id, identifier, kind, ideal_fraction) values ($1,$2,$3,$4,'apartamento',$5) returning id`,
          [tA, condo, bId, ident, fraction],
        )).id;
        units.push({ id, label: `${bName}-${ident}` });
      }
    }

    const names = [
      'Ana Beatriz Moreira', 'Bruno Carvalho Lima', 'Carla Nogueira Prado', 'Daniel Ferreira Souza', 'Eduarda Ramos Teixeira',
      'Felipe Andrade Costa', 'Gabriela Martins Rocha', 'Henrique Barros Pinto', 'Isabela Duarte Melo', 'João Pedro Azevedo',
      'Karina Lopes Vieira', 'Lucas Monteiro Dias', 'Marina Castro Freitas',
    ];
    const people: string[] = [];
    for (let i = 0; i < names.length; i++) {
      const cpf = cpfFrom(100200300 + i * 7919);
      people.push((await one<{ id: string }>(
        `insert into people (tenant_id, kind, name, document_enc, document_hash, document_masked, email)
         values ($1,'pf',$2,$3,$4,$5,$6) returning id`,
        [tA, names[i], crypto.encrypt(cpf), crypto.blindIndex(cpf), maskDocument(cpf), i === 7 ? null : `pessoa${i + 1}@exemplo.demo`],
      )).id);
    }
    const own = (unitIdx: number, personIdx: number, relation = 'proprietario', rep = true) =>
      client.query(
        `insert into unit_ownerships (tenant_id, unit_id, person_id, relation, is_voting_representative) values ($1,$2,$3,$4,$5)`,
        [tA, units[unitIdx]!.id, people[personIdx], relation, rep],
      );
    // Unidades 0..9 com titulares individuais; pessoa 0 possui duas unidades (0 e 6).
    for (let u = 0; u < 10; u++) await own(u, u === 6 ? 0 : u);
    // Unidade 10 com coproprietários (pessoa 10 designada, pessoa 11 coproprietária)
    await own(10, 10, 'proprietario', true);
    await own(10, 11, 'coproprietario', false);
    // Unidade 11 sem titular cadastrado (gera alerta). Pessoa 12 = procuradora (sem unidade).

    const sindico = await user('sindico@acacias.demo', 'Síndico Acácias');
    await assign(sindico, 'sindico', tA, condo);
    const presidente = await user('presidente@acacias.demo', 'Presidente da Mesa');
    await assign(presidente, 'assembly_president', tA, condo);
    const credenciador = await user('credenciamento@acacias.demo', 'Apoio ao Credenciamento');
    await assign(credenciador, 'accreditation_agent', tA, condo);
    const tecnico = await user('tecnico@acacias.demo', 'Operador Técnico');
    await assign(tecnico, 'technical_operator', tA, condo);
    const voterUsers: [number, string][] = [[0, 'ana'], [1, 'bruno'], [2, 'carla'], [3, 'daniel'], [10, 'karina'], [12, 'marina']];
    for (const [pi, nick] of voterUsers) {
      const uid = await user(`${nick}@acacias.demo`, names[pi]!);
      await assign(uid, pi === 12 ? 'procurador' : 'condomino', tA, condo);
      await client.query('update people set user_id = $2 where id = $1', [people[pi], uid]);
    }

    // Regras (cópias dos modelos) — homologação DEMONSTRATIVA
    const ruleIds: Record<string, string> = {};
    for (const code of ['CC1352-PRESENCA-1A', 'CC1353-PRESENCA-2A', 'CC1352-MAIORIA-PRESENTES-FRACAO', 'CC1351-DOIS-TERCOS', 'CC1352-MAIORIA-PRESENTES-UNIDADE']) {
      const t = RULE_TEMPLATES.find((x) => x.code === code)!;
      ruleIds[code] = (await one<{ id: string }>(
        `insert into quorum_rules (tenant_id, condominium_id, code, version, name, purpose, legal_basis, definition, status,
            effective_from, template_code, created_by, approved_by, approved_at, approval_notes)
         values ($1,$2,$3,1,$4,$5,$6,$7,'approved',current_date,$3,$8,$8,now(),
                 'HOMOLOGAÇÃO DE DEMONSTRAÇÃO — sem validade jurídica. Requer validação por profissional habilitado.') returning id`,
        [tA, condo, code, t.name, t.definition.purpose, t.legalBasis, JSON.stringify(t.definition), sindico],
      )).id;
    }

    // Assembleia convocada, com pauta e votações preparadas
    const first = new Date(Date.now() + 2 * 3600_000);
    const second = new Date(first.getTime() + 30 * 60_000);
    const asm = (await one<{ id: string }>(
      `insert into assemblies (tenant_id, condominium_id, code, title, kind, modality, status, timezone, location,
          first_call_at, second_call_at, first_call_presence_rule_id, second_call_presence_rule_id,
          rules_homologated_at, rules_homologated_by, rules_homologation_notes, created_by)
       values ($1,$2,$3,'Assembleia Geral Extraordinária — Reforma da fachada','AGE','hibrida','called','America/Sao_Paulo',
               'Salão de festas — Torre A', $4, $5, $6, $7, now(), $8, 'Demonstração', $8) returning id`,
      [tA, condo, `${first.getFullYear()}-001`, first, second, ruleIds['CC1352-PRESENCA-1A'], ruleIds['CC1353-PRESENCA-2A'], sindico],
    )).id;
    for (const [from, to] of [[null, 'draft'], ['draft', 'in_review'], ['in_review', 'approved_for_call'], ['approved_for_call', 'called']]) {
      await client.query(
        'insert into assembly_status_history (tenant_id, assembly_id, from_status, to_status, actor_id) values ($1,$2,$3,$4,$5)',
        [tA, asm, from, to, sindico],
      );
    }
    const item1 = (await one<{ id: string }>(
      `insert into agenda_items (tenant_id, assembly_id, position, title, description) values ($1,$2,1,'Aprovação do orçamento da reforma da fachada',
        'Deliberar sobre a contratação da empresa vencedora da tomada de preços (anexo I).') returning id`, [tA, asm])).id;
    const item2 = (await one<{ id: string }>(
      `insert into agenda_items (tenant_id, assembly_id, position, title, description) values ($1,$2,2,'Alteração do regimento interno — horário de obras',
        'Proposta de alteração do art. 12 do regimento interno.') returning id`, [tA, asm])).id;
    await one(
      `insert into agenda_items (tenant_id, assembly_id, position, title, item_type) values ($1,$2,3,'Assuntos gerais','informativo') returning id`, [tA, asm]);

    // Edital de demonstração já publicado (sem envios: destinatários são gerados apenas por publicação real).
    {
      const snapshot = { demo: true, assembly: { code: `${first.getFullYear()}-001`, firstCallAt: first.toISOString(), secondCallAt: second.toISOString() } };
      const body = 'Ficam convocados os senhores condôminos para a Assembleia Geral Extraordinária, a realizar-se de forma híbrida, para deliberar sobre a ordem do dia abaixo.';
      const hash = createHash('sha256').update(JSON.stringify({ body, snapshot })).digest('hex');
      await client.query(
        `insert into convocations (tenant_id, assembly_id, version, status, subject, body, snapshot, content_sha256, published_at, published_by, created_by)
         values ($1,$2,1,'published','Edital de convocação — AGE Reforma da fachada',$3,$4,$5,now(),$6,$6)`,
        [tA, asm, body, JSON.stringify(snapshot), hash, sindico],
      );
    }

    const ballot = async (itemId: string, title: string, question: string, rule: string, secrecy = 'nominal') => {
      const b = (await one<{ id: string }>(
        `insert into ballots (tenant_id, assembly_id, agenda_item_id, title, question, ballot_type, secrecy, approval_rule_id, created_by)
         values ($1,$2,$3,$4,$5,'yes_no',$6,$7,$8) returning id`,
        [tA, asm, itemId, title, question, secrecy, ruleIds[rule], sindico],
      )).id;
      let pos = 1;
      for (const [label, kind] of [['Sim', 'yes'], ['Não', 'no'], ['Abstenção', 'abstention']]) {
        await client.query('insert into ballot_options (tenant_id, ballot_id, position, label, kind) values ($1,$2,$3,$4,$5)', [tA, b, pos++, label, kind]);
      }
    };
    await ballot(item1, 'Orçamento da fachada', 'Aprova a contratação da empresa X pelo valor de R$ 480.000,00, em 12 parcelas?', 'CC1352-MAIORIA-PRESENTES-FRACAO');
    await ballot(item2, 'Horário de obras', 'Aprova a alteração do horário de obras para 8h às 17h em dias úteis?', 'CC1352-MAIORIA-PRESENTES-UNIDADE', 'secret');

    // Procurações: aprovada (unidade 9 → Marina) e pendente (unidade 8 → Marina)
    const poa1 = (await one<{ id: string }>(
      `insert into powers_of_attorney (tenant_id, condominium_id, grantor_person_id, attorney_person_id, scope, valid_from, status,
          submitted_by, reviewed_by, reviewed_at, review_notes)
       values ($1,$2,$3,$4,'general', now() - interval '1 day', 'approved', $5, $5, now(), 'Documento conferido (demonstração)') returning id`,
      [tA, condo, people[9], people[12], sindico],
    )).id;
    await client.query('insert into poa_units (tenant_id, poa_id, unit_id) values ($1,$2,$3)', [tA, poa1, units[9]!.id]);
    const poa2 = (await one<{ id: string }>(
      `insert into powers_of_attorney (tenant_id, condominium_id, grantor_person_id, attorney_person_id, scope, assembly_id, valid_from, status, submitted_by)
       values ($1,$2,$3,$4,'assembly',$5, now() - interval '1 day', 'pending', $6) returning id`,
      [tA, condo, people[8], people[12], asm, sindico],
    )).id;
    await client.query('insert into poa_units (tenant_id, poa_id, unit_id) values ($1,$2,$3)', [tA, poa2, units[8]!.id]);
    for (const [p, ev] of [[poa1, 'submitted'], [poa1, 'approved'], [poa2, 'submitted']]) {
      await client.query('insert into poa_events (tenant_id, poa_id, event, actor_id) values ($1,$2,$3,$4)', [tA, p, ev, sindico]);
    }

    // ---------------- Cliente B — condomínio independente (para demonstrar isolamento)
    const tB = (await one<{ id: string }>(
      `insert into tenants (name, kind) values ('Condomínio Edifício Beta (Demo)', 'condominio_independente') returning id`,
    )).id;
    const betaAdmin = await user('admin@beta.demo', 'Administração Beta');
    await assign(betaAdmin, 'tenant_admin', tB);
    const condoB = (await one<{ id: string }>(
      `insert into condominiums (tenant_id, name, type, legal_regime) values ($1,'Edifício Beta','residencial_vertical','condominio_edilicio') returning id`, [tB])).id;
    for (const [ident, f] of [['101', '0.3333333333'], ['102', '0.3333333333'], ['103', '0.3333333334']]) {
      await client.query(`insert into units (tenant_id, condominium_id, identifier, ideal_fraction) values ($1,$2,$3,$4)`, [tB, condoB, ident, f]);
    }

    for (const t of [null, tA, tB]) {
      await client.query(
        `insert into audit_events (chain_key, chain_seq, tenant_id, action, resource_type, outcome, metadata, prev_hash, hash)
         values ('',0,$1,'seed.demo_data','system','success','{"note":"dados de demonstração"}','','')`,
        [t],
      );
    }
    await client.query('commit');
    log('✔ dados de demonstração criados');
    log(`  senha de todos os usuários de demonstração: ${DEMO_PASSWORD}`);
    log('  plataforma: admin@lsglobal.local | cliente A: gestor@horizonte.demo, sindico@acacias.demo, presidente@acacias.demo');
    log('  condôminos: ana@ (2 unidades), bruno@, carla@, daniel@, karina@ (coproprietária) | procuradora: marina@acacias.demo');
    log('  cliente B (isolamento): admin@beta.demo');
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  seed().catch((err) => {
    console.error('✖ seed falhou:', err.message);
    process.exit(1);
  });
}
