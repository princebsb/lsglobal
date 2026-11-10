/**
 * Planejamento e ciclo de vida: criação, pauta, homologação de regras, transições,
 * mudança de elegibilidade, cancelamento justificado de votação e nova rodada.
 */
import type { INestApplication } from '@nestjs/common';
import { as, key, login, startApp, type Session } from './helpers';

describe('Assembleia — planejamento, homologação e rodadas', () => {
  let app: INestApplication;
  let sindico: Session, presidente: Session, ana: Session;
  let condoId: string, assemblyId: string, itemId: string;
  let ruleApproval: string, rulePresence1: string, draftRule: string;

  beforeAll(async () => {
    app = await startApp();
    [sindico, presidente, ana] = await Promise.all(['sindico', 'presidente', 'ana'].map((n) => login(app, `${n}@acacias.demo`)));
    condoId = (await as(app, sindico).get('/condominiums')).body[0].id;
    const rules = (await as(app, sindico).get(`/condominiums/${condoId}/rules`)).body as { id: string; code: string; status: string }[];
    ruleApproval = rules.find((r) => r.code === 'CC1352-MAIORIA-PRESENTES-UNIDADE')!.id;
    rulePresence1 = rules.find((r) => r.code === 'CC1352-PRESENCA-1A')!.id;
  });
  afterAll(async () => app.close());

  it('regras: cópia de modelo entra como rascunho, homologação exige fundamento e torna a regra imutável', async () => {
    const r = await as(app, sindico).post(`/condominiums/${condoId}/rules/from-template`, { templateCode: 'CC1341-UTEIS' });
    expect(r.status).toBe(201);
    draftRule = r.body.id;
    expect((await as(app, sindico).post(`/rules/${draftRule}/approve`, { notes: '' })).status).toBe(400);
    expect((await as(app, ana).post(`/rules/${draftRule}/approve`, { notes: 'Conferido com a convenção' })).status).toBe(403);
    expect((await as(app, sindico).post(`/rules/${draftRule}/approve`, { notes: 'Conferido com a convenção, art. 20' })).status).toBe(201);
    expect((await as(app, sindico).post(`/rules/${draftRule}/approve`, { notes: 'De novo' })).status).toBe(409);
    const v2 = await as(app, sindico).post(`/rules/${draftRule}/new-version`, {});
    expect(v2.body.version).toBe(2);
  });

  it('cria assembleia em rascunho; 2ª convocação deve ser posterior à 1ª', async () => {
    const t = new Date(Date.now() + 86400_000);
    const bad = await as(app, sindico).post('/assemblies', {
      condominiumId: condoId, title: 'AGO 2026', kind: 'AGO', modality: 'virtual',
      firstCallAt: t.toISOString(), secondCallAt: new Date(t.getTime() - 60_000).toISOString(),
    });
    expect(bad.status).toBe(400);
    const r = await as(app, sindico).post('/assemblies', {
      condominiumId: condoId, title: 'AGO 2026', kind: 'AGO', modality: 'virtual',
      firstCallAt: t.toISOString(), secondCallAt: new Date(t.getTime() + 1800_000).toISOString(),
    });
    expect(r.status).toBe(201);
    assemblyId = r.body.id;
  });

  it('não aprova para convocação sem pauta e sem homologação', async () => {
    expect((await as(app, sindico).post(`/assemblies/${assemblyId}/transition`, { to: 'in_review' })).status).toBe(201);
    const noRules = await as(app, sindico).post(`/assemblies/${assemblyId}/transition`, { to: 'approved_for_call' });
    expect(noRules.status).toBe(422);
    expect(noRules.body.code).toBe('RULES_NOT_HOMOLOGATED');
    const item = await as(app, sindico).post(`/assemblies/${assemblyId}/agenda`, { title: 'Prestação de contas 2025' });
    itemId = item.body.id;
    const hom = await as(app, sindico).post(`/assemblies/${assemblyId}/homologate`, {
      firstCallPresenceRuleId: rulePresence1, secondCallPresenceRuleId: null, notes: 'Regras conferidas com a convenção',
    });
    expect(hom.status).toBe(201);
    const wrongPurpose = await as(app, sindico).post(`/assemblies/${assemblyId}/homologate`, {
      firstCallPresenceRuleId: ruleApproval, secondCallPresenceRuleId: null, notes: 'Tentativa inválida',
    });
    expect(wrongPurpose.status).toBe(422);
    expect((await as(app, sindico).post(`/assemblies/${assemblyId}/transition`, { to: 'approved_for_call' })).status).toBe(201);
    await as(app, sindico).put(`/assemblies/${assemblyId}/convocations/draft`, {
      subject: 'Edital AGO 2026', body: 'Ficam convocados os condôminos para a AGO 2026.',
    });
    expect((await as(app, sindico).post(`/assemblies/${assemblyId}/convocations/publish`, { acknowledgeLegalNotice: true })).status).toBe(201);
  });

  it('pauta é bloqueada após a convocação', async () => {
    expect((await as(app, sindico).post(`/assemblies/${assemblyId}/agenda`, { title: 'Item tardio' })).status).toBe(409);
  });

  it('votação exige regra homologada', async () => {
    const r = await as(app, sindico).post(`/assemblies/${assemblyId}/ballots`, {
      agendaItemId: itemId, title: 'Contas', question: 'Aprova as contas?', ballotType: 'yes_no',
      approvalRuleId: (await as(app, sindico).get(`/condominiums/${condoId}/rules`)).body.find((x: { status: string }) => x.status === 'draft').id,
    });
    expect(r.status).toBe(422);
  });

  let ballotId: string;
  it('cancelamento justificado preserva votos e nova rodada recebe identificador distinto', async () => {
    const created = await as(app, sindico).post(`/assemblies/${assemblyId}/ballots`, {
      agendaItemId: itemId, title: 'Contas', question: 'Aprova as contas?', ballotType: 'yes_no', approvalRuleId: ruleApproval,
    });
    expect(created.status).toBe(201);
    ballotId = created.body.id;
    await as(app, presidente).post(`/assemblies/${assemblyId}/transition`, { to: 'accreditation' });
    const anaUnits = (await as(app, ana).get(`/assemblies/${assemblyId}/my`)).body.units;
    await as(app, ana).post(`/assemblies/${assemblyId}/accreditations/self`, { unitId: anaUnits[0].unit_id });
    await as(app, ana).post(`/assemblies/${assemblyId}/accreditations/self`, { unitId: anaUnits[1].unit_id });
    expect((await as(app, presidente).post(`/assemblies/${assemblyId}/transition`, { to: 'in_progress', callNumber: 1 })).status).toBe(201);
    expect((await as(app, presidente).post(`/ballots/${ballotId}/open`)).status).toBe(200);
    const yes = (await as(app, ana).get(`/ballots/${ballotId}`)).body.options[0].id;
    expect((await as(app, ana).post(`/ballots/${ballotId}/votes`, { unitId: anaUnits[0].unit_id, optionIds: [yes], idempotencyKey: key() })).status).toBe(201);
    expect((await as(app, presidente).post(`/ballots/${ballotId}/cancel`, { reason: '' })).status).toBe(400);
    const c = await as(app, presidente).post(`/ballots/${ballotId}/cancel`, { reason: 'Texto da deliberação continha erro material' });
    expect(c.status).toBe(200);
    expect(c.body.votesPreserved).toBe(1);
    const nr = await as(app, presidente).post(`/ballots/${ballotId}/new-round`);
    expect(nr.status).toBe(201);
    expect(nr.body.round).toBe(2);
    expect(nr.body.id).not.toBe(ballotId);
    ballotId = nr.body.id;
  });

  it('mudança de elegibilidade antes da abertura retira a unidade da base eleitoral', async () => {
    const anaUnits = (await as(app, ana).get(`/assemblies/${assemblyId}/my`)).body.units;
    const u = anaUnits[1].unit_id;
    const restricted = await as(app, sindico).patch(`/condominiums/${condoId}/units/${u}/eligibility`, { votingStatus: 'restricted' });
    expect(restricted.status).toBe(400); // fundamento obrigatório
    expect((await as(app, sindico).patch(`/condominiums/${condoId}/units/${u}/eligibility`, { votingStatus: 'restricted', reason: 'Débito condominial (art. 1.335, III) — demonstração' })).status).toBe(200);
    const open = await as(app, presidente).post(`/ballots/${ballotId}/open`);
    expect(open.body.electorate.units).toBe(11);
    const yes = (await as(app, ana).get(`/ballots/${ballotId}`)).body.options[0].id;
    const r = await as(app, ana).post(`/ballots/${ballotId}/votes`, { unitId: u, optionIds: [yes], idempotencyKey: key() });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('UNIT_NOT_ELIGIBLE');
    // restaurar após a abertura não altera o snapshot da votação já aberta
    await as(app, sindico).patch(`/condominiums/${condoId}/units/${u}/eligibility`, { votingStatus: 'eligible' });
    const again = await as(app, ana).post(`/ballots/${ballotId}/votes`, { unitId: u, optionIds: [yes], idempotencyKey: key() });
    expect(again.status).toBe(403);
  });

  it('em 1ª convocação sem presença mínima, a apuração indica quórum não atingido', async () => {
    const anaUnits = (await as(app, ana).get(`/assemblies/${assemblyId}/my`)).body.units;
    const yes = (await as(app, ana).get(`/ballots/${ballotId}`)).body.options[0].id;
    expect((await as(app, ana).post(`/ballots/${ballotId}/votes`, { unitId: anaUnits[0].unit_id, optionIds: [yes], idempotencyKey: key() })).status).toBe(201);
    await as(app, presidente).post(`/ballots/${ballotId}/close`);
    const t = await as(app, presidente).post(`/ballots/${ballotId}/tally`);
    expect(t.body.outcome).toBe('quorum_not_met');
    const sim = await as(app, sindico).get(`/assemblies/${assemblyId}/quorum/simulation?presentPercent=50`);
    expect(sim.status).toBe(200);
    expect(sim.body.rules.length).toBeGreaterThan(0);
  });
});
