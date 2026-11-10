import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CONVOCATION_LEGAL_NOTICE, ConvocationDraftSchema, ConvocationPublishSchema } from '@lsg/shared';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { AuthzService } from '../../authz/authz.service';
import { Anon, Ctx, Public, RequirePermission, TenantScoped, ZodBody, ZodPipe, conflict, notFound, type AnonCtx, type ReqCtx } from '../../common/http';
import { dbc } from '../../common/scope';
import { DbService } from '../../db/db.service';
import { AssembliesService } from '../assemblies/assemblies.service';
import { CONVOCATION_DRAFT_STATUSES, ConvocationsService } from './convocations.service';

@ApiTags('Convocações')
@ApiBearerAuth()
@TenantScoped()
@Controller()
export class ConvocationsController {
  constructor(
    private readonly db: DbService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly assemblies: AssembliesService,
    private readonly svc: ConvocationsService,
  ) {}

  /** Versões do edital da assembleia, com resumo de envios para quem convoca. */
  @Get('assemblies/:id/convocations')
  @RequirePermission('assembly.view')
  async list(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.assemblies.load(q, id);
      this.authz.require(ctx, 'assembly.view', a.condominium_id);
      const canConvene = this.authz.has(ctx, 'assembly.convene', a.condominium_id);
      const items = await q.rows(
        `select c.id, c.version, c.status, c.subject, c.body, c.content_sha256, c.published_at, c.rectification_reason,
                c.created_at, c.updated_at, pu.full_name as published_by_name,
                ${canConvene ? `(select json_build_object(
                    'recipients', count(*),
                    'withoutAddress', count(*) filter (where r.channel = 'none'),
                    'sent', count(*) filter (where exists (select 1 from convocation_deliveries d where d.recipient_id = r.id and d.status = 'sent')),
                    'failed', count(*) filter (where r.channel <> 'none' and not exists (select 1 from convocation_deliveries d where d.recipient_id = r.id and d.status in ('sent','queued','sending'))),
                    'pending', count(*) filter (where exists (select 1 from convocation_deliveries d where d.recipient_id = r.id and d.status in ('queued','sending'))),
                    'opened', count(*) filter (where exists (select 1 from convocation_delivery_events e where e.recipient_id = r.id and e.event = 'opened')))
                  from convocation_recipients r where r.convocation_id = c.id)` : 'null'} as stats
           from convocations c left join users pu on pu.id = c.published_by
          where c.assembly_id = $1 ${canConvene ? '' : `and c.status in ('published','superseded')`}
          order by c.version desc`,
        [id],
      );
      const warnings = canConvene ? await this.svc.leadTimeWarnings(q, a) : [];
      return { items, warnings, legalNotice: CONVOCATION_LEGAL_NOTICE, canEdit: canConvene && CONVOCATION_DRAFT_STATUSES.includes(a.status) };
    });
  }

  /** Cria ou atualiza o rascunho do edital (a próxima versão). */
  @Put('assemblies/:id/convocations/draft')
  @RequirePermission('assembly.convene')
  @ZodBody(ConvocationDraftSchema)
  async saveDraft(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ConvocationDraftSchema)) body: z.infer<typeof ConvocationDraftSchema>) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.assemblies.load(q, id, true);
      this.authz.require(ctx, 'assembly.convene', a.condominium_id);
      if (!CONVOCATION_DRAFT_STATUSES.includes(a.status)) throw conflict('O edital não pode mais ser alterado neste estado da assembleia', 'INVALID_STATE');
      const draft = await q.maybe<{ id: string }>(`select id from convocations where assembly_id = $1 and status = 'draft' for update`, [id]);
      if (draft) {
        await q.exec('update convocations set subject = $2, body = $3 where id = $1', [draft.id, body.subject, body.body]);
        return { id: draft.id };
      }
      const v = await q.one<{ n: number }>('select coalesce(max(version), 0)::int + 1 as n from convocations where assembly_id = $1', [id]);
      const r = await q.one<{ id: string }>(
        `insert into convocations (tenant_id, assembly_id, version, subject, body, created_by) values ($1,$2,$3,$4,$5,$6) returning id`,
        [ctx.tenantId, id, v.n, body.subject, body.body, ctx.auth.userId],
      );
      await this.audit.record(q, ctx, { action: 'convocation.draft_created', resourceType: 'convocation', resourceId: r.id, assemblyId: id, after: { version: v.n } });
      return { id: r.id };
    });
  }

  @Post('assemblies/:id/convocations/publish')
  @RequirePermission('assembly.convene')
  @ZodBody(ConvocationPublishSchema)
  async publish(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(ConvocationPublishSchema)) body: z.infer<typeof ConvocationPublishSchema>) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.assemblies.load(q, id, true);
      this.authz.require(ctx, 'assembly.convene', a.condominium_id);
      const warnings = await this.svc.leadTimeWarnings(q, a);
      const r = await this.svc.publish(q, ctx, a, body.rectificationReason);
      return { ...r, warnings };
    });
  }

  /** Destinatários com situação do último envio e da primeira abertura. */
  @Get('convocations/:cid/recipients')
  @RequirePermission('assembly.convene')
  async recipients(@Ctx() ctx: ReqCtx, @Param('cid', ParseUUIDPipe) cid: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const c = await q.maybe<{ assembly_id: string }>('select assembly_id from convocations where id = $1', [cid]);
      if (!c) throw notFound('Convocação');
      const a = await this.assemblies.load(q, c.assembly_id);
      this.authz.require(ctx, 'assembly.convene', a.condominium_id);
      return q.rows(
        `select r.id, concat_ws(' - ', b.name, u.identifier) as unit, p.name as person_name, r.relation, r.channel, r.address_masked,
                d.status as delivery_status, d.attempts, d.last_error, d.sent_at, d.provider_message_id,
                (select min(e.occurred_at) from convocation_delivery_events e where e.recipient_id = r.id and e.event = 'opened') as first_opened_at,
                (select count(*)::int from convocation_delivery_events e where e.recipient_id = r.id and e.event = 'opened') as opens
           from convocation_recipients r
           join units u on u.id = r.unit_id left join buildings b on b.id = u.building_id
           join people p on p.id = r.person_id
           left join lateral (select * from convocation_deliveries d where d.recipient_id = r.id order by d.created_at desc limit 1) d on true
          where r.convocation_id = $1
          order by b.name nulls first, u.identifier, p.name`,
        [cid],
      );
    });
  }

  /** Histórico completo de eventos de um destinatário. */
  @Get('convocations/:cid/recipients/:rid/events')
  @RequirePermission('assembly.convene')
  async events(@Ctx() ctx: ReqCtx, @Param('cid', ParseUUIDPipe) cid: string, @Param('rid', ParseUUIDPipe) rid: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const c = await q.maybe<{ assembly_id: string }>('select assembly_id from convocations where id = $1', [cid]);
      if (!c) throw notFound('Convocação');
      const a = await this.assemblies.load(q, c.assembly_id);
      this.authz.require(ctx, 'assembly.convene', a.condominium_id);
      return q.rows(
        `select e.id, e.event, e.detail - 'ip' - 'userAgent' as detail, e.occurred_at from convocation_delivery_events e
           join convocation_recipients r on r.id = e.recipient_id
          where e.recipient_id = $1 and r.convocation_id = $2 order by e.occurred_at, e.id`,
        [rid, cid],
      );
    });
  }

  @Post('convocations/:cid/recipients/:rid/resend')
  @RequirePermission('assembly.convene')
  async resend(@Ctx() ctx: ReqCtx, @Param('cid', ParseUUIDPipe) cid: string, @Param('rid', ParseUUIDPipe) rid: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const c = await q.maybe<{ assembly_id: string }>('select assembly_id from convocations where id = $1', [cid]);
      if (!c) throw notFound('Convocação');
      const a = await this.assemblies.load(q, c.assembly_id);
      this.authz.require(ctx, 'assembly.convene', a.condominium_id);
      return this.svc.resend(q, ctx, cid, rid);
    });
  }
}

/** Link pessoal enviado por e-mail: exibe o edital e registra a abertura. Não autentica. */
@ApiTags('Convocações')
@Controller('public/convocations')
export class PublicConvocationsController {
  constructor(private readonly svc: ConvocationsService) {}

  @Public()
  @Get(':token')
  async open(@Param('token') token: string, @Anon() anon: AnonCtx) {
    const r = await this.svc.openLink(token, { ip: anon.ip, userAgent: anon.userAgent });
    return r;
  }
}
