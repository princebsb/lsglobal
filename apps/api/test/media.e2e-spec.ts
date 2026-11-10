/**
 * Transmissão (LiveKit): tokens por papel, fila de palavra, gravação confirmada por webhook
 * assinado, integridade (SHA-256) e idempotência dos webhooks. O servidor de mídia é simulado:
 * as chamadas ao LiveKit/Egress são substituídas por espiões.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { resetEnvCache } from '../src/config/env';
import { LivekitService } from '../src/modules/media/livekit.service';
import { adminDb, api, as, login, startApp, type Session } from './helpers';

const KEY = 'lsg-test-key';
const SECRET = 'test-secret-0123456789-abcdefghijklmnop';
const recDir = mkdtempSync(join(tmpdir(), 'lsg-rec-'));

async function webhook(app: INestApplication, payload: object, secret = SECRET) {
  const body = JSON.stringify(payload);
  const at = new AccessToken(KEY, secret);
  at.sha256 = createHash('sha256').update(body).digest('base64');
  const jwt = await at.toJwt();
  return api(app).post('/api/v1/webhooks/livekit').set('Content-Type', 'application/webhook+json').set('Authorization', jwt).send(body);
}

describe('Transmissão e gravação (LiveKit simulado)', () => {
  let app: INestApplication;
  let lk: LivekitService;
  let sindico: Session, presidente: Session, tecnico: Session, ana: Session, bruno: Session;
  let assemblyId: string, room: string;
  let setPublish: jest.SpyInstance;
  let egressFile = '';

  beforeAll(async () => {
    Object.assign(process.env, {
      LIVEKIT_URL: 'ws://127.0.0.1:7880',
      LIVEKIT_PUBLIC_URL: 'wss://midia.exemplo.test',
      LIVEKIT_API_KEY: KEY,
      LIVEKIT_API_SECRET: SECRET,
      LIVEKIT_EGRESS_ENABLED: 'true',
      RECORDINGS_DIR: recDir,
      // Isola o teste do .env local (ex.: Egress no WSL com caminho /mnt/d/...).
      EGRESS_RECORDINGS_DIR: '',
    });
    resetEnvCache();
    app = await startApp();
    lk = app.get(LivekitService);
    setPublish = jest.spyOn(lk, 'setPublish').mockResolvedValue(true);
    jest.spyOn(lk, 'listParticipants').mockResolvedValue([]);
    jest.spyOn(lk, 'startRecording').mockImplementation(async (_room, filepath) => {
      egressFile = filepath;
      return `EG_${Date.now()}`;
    });
    jest.spyOn(lk, 'stopRecording').mockResolvedValue();

    [sindico, presidente, tecnico, ana, bruno] = await Promise.all(
      ['sindico', 'presidente', 'tecnico', 'ana', 'bruno'].map((n) => login(app, `${n}@acacias.demo`)),
    );
    const condoId = (await as(app, sindico).get('/condominiums')).body[0].id;
    const rules = (await as(app, sindico).get(`/condominiums/${condoId}/rules`)).body as { id: string; code: string }[];
    const a = await as(app, sindico).post('/assemblies', {
      condominiumId: condoId, title: 'AGE — transmissão', kind: 'AGE', modality: 'virtual', firstCallAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    assemblyId = a.body.id;
    room = `lsg_${assemblyId}`;
    await as(app, sindico).post(`/assemblies/${assemblyId}/agenda`, { title: 'Assuntos gerais', itemType: 'informativo' });
    await as(app, sindico).post(`/assemblies/${assemblyId}/homologate`, {
      firstCallPresenceRuleId: rules.find((r) => r.code === 'CC1352-PRESENCA-1A')!.id, secondCallPresenceRuleId: null, notes: 'Conferido com a convenção',
    });
    for (const to of ['in_review', 'approved_for_call']) await as(app, sindico).post(`/assemblies/${assemblyId}/transition`, { to });
    await as(app, sindico).put(`/assemblies/${assemblyId}/convocations/draft`, { subject: 'Edital AGE transmissão', body: 'Ficam convocados os condôminos para a AGE virtual.' });
    expect((await as(app, sindico).post(`/assemblies/${assemblyId}/convocations/publish`, { acknowledgeLegalNotice: true })).status).toBe(201);
  });
  afterAll(async () => app.close());

  const decode = (token: string) => new TokenVerifier(KEY, SECRET).verify(token);

  it('mesa recebe token com publicação; condômino sem credenciamento é recusado', async () => {
    const r = await as(app, presidente).post(`/assemblies/${assemblyId}/media/token`);
    expect(r.status).toBe(201);
    expect(r.body.url).toBe('wss://midia.exemplo.test');
    expect(r.body.role).toBe('staff');
    const claims = await decode(r.body.token);
    expect(claims.video?.room).toBe(room);
    expect(claims.video?.canPublish).toBe(true);
    expect(claims.sub).toBe(`staff:${presidente.userId}`);

    const denied = await as(app, ana).post(`/assemblies/${assemblyId}/media/token`);
    expect(denied.status).toBe(403);
  });

  it('condômino credenciado assiste sem publicar', async () => {
    await as(app, presidente).post(`/assemblies/${assemblyId}/transition`, { to: 'accreditation' });
    for (const s of [ana, bruno]) {
      const units = (await as(app, s).get(`/assemblies/${assemblyId}/my`)).body.units;
      expect((await as(app, s).post(`/assemblies/${assemblyId}/accreditations/self`, { unitId: units[0].unit_id })).status).toBe(201);
    }
    const r = await as(app, ana).post(`/assemblies/${assemblyId}/media/token`);
    expect(r.status).toBe(201);
    expect(r.body.role).toBe('attendee');
    const claims = await decode(r.body.token);
    expect(claims.video?.canPublish).toBe(false);
    expect(claims.video?.canSubscribe).toBe(true);
    expect(claims.sub).toMatch(/^p:/);
    expect(JSON.parse(claims.metadata!).units.length).toBeGreaterThan(0);
  });

  it('fila de palavra: um pedido ativo por pessoa, um orador por vez, permissão aplicada na sala', async () => {
    expect((await as(app, ana).post(`/assemblies/${assemblyId}/floor`, { topic: 'Dúvida' })).status).toBe(409); // sessão não iniciada
    expect((await as(app, presidente).post(`/assemblies/${assemblyId}/transition`, { to: 'in_progress', callNumber: 1 })).status).toBe(201);
    const fa = await as(app, ana).post(`/assemblies/${assemblyId}/floor`, { topic: 'Dúvida sobre o item 1' });
    expect(fa.status).toBe(201);
    expect((await as(app, ana).post(`/assemblies/${assemblyId}/floor`, {})).status).toBe(409);
    const fb = await as(app, bruno).post(`/assemblies/${assemblyId}/floor`, {});
    expect(fb.status).toBe(201);

    expect((await as(app, ana).post(`/floor/${fa.body.id}/decision`, { decision: 'grant' })).status).toBe(403);
    const g = await as(app, presidente).post(`/floor/${fa.body.id}/decision`, { decision: 'grant', maxSeconds: 180 });
    expect(g.status).toBe(201);
    expect(g.body.appliedToRoom).toBe(true);
    expect(setPublish).toHaveBeenLastCalledWith(room, expect.stringMatching(/^p:/), true);
    const busy = await as(app, presidente).post(`/floor/${fb.body.id}/decision`, { decision: 'grant' });
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('FLOOR_BUSY');

    // com a palavra, um novo token já permite publicar microfone/câmera
    const t = await decode((await as(app, ana).post(`/assemblies/${assemblyId}/media/token`)).body.token);
    expect(t.video?.canPublish).toBe(true);

    // participante vê a própria posição, não a fila completa com terceiros
    const viewBruno = (await as(app, bruno).get(`/assemblies/${assemblyId}/media`)).body.floor as { mine: boolean; status: string; person_id?: string }[];
    expect(viewBruno.every((x) => x.mine || x.status === 'granted')).toBe(true);
    expect(viewBruno.find((x) => !x.mine)?.person_id).toBeUndefined();

    expect((await as(app, presidente).post(`/floor/${fa.body.id}/decision`, { decision: 'end' })).status).toBe(201);
    expect(setPublish).toHaveBeenLastCalledWith(room, expect.stringMatching(/^p:/), false);
    expect((await as(app, bruno).post(`/floor/${fb.body.id}/cancel`)).status).toBe(201);
    const tl = (await as(app, presidente).get(`/assemblies/${assemblyId}/timeline`)).body as { kind: string }[];
    expect(tl.map((e) => e.kind)).toEqual(expect.arrayContaining(['floor.requested', 'floor.granted', 'floor.ended']));
  });

  let recordingId: string, egressId: string;
  it('gravação só é considerada iniciada após confirmação do servidor de mídia (webhook assinado)', async () => {
    expect((await as(app, ana).post(`/assemblies/${assemblyId}/recordings/start`)).status).toBe(403);
    const r = await as(app, tecnico).post(`/assemblies/${assemblyId}/recordings/start`);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('starting');
    recordingId = r.body.id;
    egressId = r.body.egressId;
    expect(egressFile.startsWith(recDir)).toBe(true);
    expect((await as(app, presidente).post(`/assemblies/${assemblyId}/recordings/start`)).status).toBe(409);

    // assinatura inválida é rejeitada
    const forged = await webhook(app, { event: 'egress_started', id: 'EV_forged', egressInfo: { egressId, roomName: room, status: 'EGRESS_ACTIVE' } }, 'outro-segredo-0123456789-abcdefghijklmnop');
    expect(forged.status).toBe(401);

    const ev = { event: 'egress_started', id: 'EV_start_1', egressInfo: { egressId, roomName: room, status: 'EGRESS_ACTIVE', startedAt: `${BigInt(Date.now()) * 1_000_000n}` } };
    expect((await webhook(app, ev)).status).toBe(200);
    const dup = await webhook(app, ev);
    expect(dup.body.ignored).toBe('evento duplicado');
    const m = (await as(app, presidente).get(`/assemblies/${assemblyId}/media`)).body;
    expect(m.recordings[0].status).toBe('active');
    expect(m.recordings[0].started_at).toBeTruthy();
  });

  it('ao concluir, registra arquivo e SHA-256; gravação concluída é imutável', async () => {
    expect((await as(app, presidente).post(`/recordings/${recordingId}/stop`)).status).toBe(201);
    mkdirSync(dirname(egressFile), { recursive: true });
    const content = Buffer.from('conteudo-mp4-simulado');
    writeFileSync(egressFile, content);
    const ended = await webhook(app, {
      event: 'egress_ended', id: 'EV_end_1',
      egressInfo: { egressId, roomName: room, status: 'EGRESS_COMPLETE', endedAt: `${BigInt(Date.now()) * 1_000_000n}`, fileResults: [{ filename: egressFile, size: String(content.length), duration: '5000000000' }] },
    });
    expect(ended.status).toBe(200);
    const rec = (await as(app, presidente).get(`/assemblies/${assemblyId}/media`)).body.recordings[0];
    expect(rec.status).toBe('complete');
    expect(rec.sha256).toBe(createHash('sha256').update(content).digest('hex'));
    expect(Number(rec.duration_ms)).toBe(5000);

    const adm = await adminDb();
    await expect(adm.query(`update recordings set sha256 = 'x' where id = $1`, [recordingId])).rejects.toMatchObject({ code: '42501' });
    await adm.end();
  });

  it('falha de gravação gera alerta e registro na linha do tempo', async () => {
    const r = await as(app, tecnico).post(`/assemblies/${assemblyId}/recordings/start`);
    expect(r.status).toBe(201);
    await webhook(app, { event: 'egress_ended', id: 'EV_fail_1', egressInfo: { egressId: r.body.egressId, roomName: room, status: 'EGRESS_FAILED', error: 'pipeline encerrado' } });
    const m = (await as(app, presidente).get(`/assemblies/${assemblyId}/media`)).body;
    expect(m.recordings.find((x: { id: string }) => x.id === r.body.id).status).toBe('failed');
    const tl = (await as(app, presidente).get(`/assemblies/${assemblyId}/timeline`)).body as { kind: string }[];
    expect(tl.map((e) => e.kind)).toEqual(expect.arrayContaining(['recording.requested', 'recording.started', 'recording.ended', 'recording.failed']));
  });

  it('entrada e saída de participantes remotos ficam registradas como presença de conexão', async () => {
    const tok = await decode((await as(app, ana).post(`/assemblies/${assemblyId}/media/token`)).body.token);
    expect((await webhook(app, { event: 'participant_joined', id: 'EV_pj_1', room: { name: room }, participant: { identity: tok.sub } })).status).toBe(200);
    const adm = await adminDb();
    const r = await adm.query(`select event from attendance_events where assembly_id = $1 and event = 'connect'`, [assemblyId]);
    await adm.end();
    expect(r.rowCount).toBe(1);
  });
});
