import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { FloorDecisionSchema } from '@lsg/shared';
import { z } from 'zod';
import { AuthzService } from '../../authz/authz.service';
import { Ctx, Public, RequirePermission, TenantScoped, ZodBody, ZodPipe, forbidden, type AppRequest, type ReqCtx } from '../../common/http';
import { dbc } from '../../common/scope';
import { DbService } from '../../db/db.service';
import { AssembliesService } from '../assemblies/assemblies.service';
import { LivekitService } from './livekit.service';
import { MediaService } from './media.service';

const FloorRequestSchema = z.object({ topic: z.string().trim().max(300).optional() });

@ApiTags('Transmissão')
@ApiBearerAuth()
@TenantScoped()
@Controller()
export class MediaController {
  constructor(
    private readonly db: DbService,
    private readonly authz: AuthzService,
    private readonly assemblies: AssembliesService,
    private readonly media: MediaService,
  ) {}

  @Get('assemblies/:id/media')
  @RequirePermission('assembly.view')
  async overview(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.assemblies.load(q, id);
      this.authz.require(ctx, 'assembly.view', a.condominium_id);
      return this.media.overview(q, ctx, a);
    });
  }

  /** Token de acesso à sala (curta duração). Papel e permissões definidos pelo servidor. */
  @Post('assemblies/:id/media/token')
  @RequirePermission('assembly.view')
  async token(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.assemblies.load(q, id);
      this.authz.require(ctx, 'assembly.view', a.condominium_id);
      return this.media.issueToken(q, ctx, a);
    });
  }

  @Post('assemblies/:id/floor')
  @RequirePermission('assembly.attend')
  @ZodBody(FloorRequestSchema)
  async requestFloor(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(FloorRequestSchema)) body: z.infer<typeof FloorRequestSchema>) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.assemblies.load(q, id);
      this.authz.require(ctx, 'assembly.attend', a.condominium_id);
      return this.media.requestFloor(q, ctx, a, body.topic);
    });
  }

  @Post('floor/:fid/cancel')
  @RequirePermission('assembly.attend')
  async cancelFloor(@Ctx() ctx: ReqCtx, @Param('fid', ParseUUIDPipe) fid: string) {
    return this.db.tx(dbc(ctx), (q) => this.media.cancelFloor(q, ctx, fid));
  }

  @Post('floor/:fid/decision')
  @RequirePermission('assembly.conduct')
  @ZodBody(FloorDecisionSchema)
  async decideFloor(@Ctx() ctx: ReqCtx, @Param('fid', ParseUUIDPipe) fid: string, @Body(new ZodPipe(FloorDecisionSchema)) body: z.infer<typeof FloorDecisionSchema>) {
    return this.db.tx(dbc(ctx), (q) => this.media.decideFloor(q, ctx, fid, body.decision, body.maxSeconds, body.reason));
  }

  @Post('assemblies/:id/recordings/start')
  @RequirePermission('assembly.view')
  async startRecording(@Ctx() ctx: ReqCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(dbc(ctx), async (q) => {
      const a = await this.assemblies.load(q, id, true);
      if (!this.media.isStaff(ctx, a)) throw forbidden('Somente a mesa ou a operação técnica controlam a gravação');
      return this.media.startRecording(q, ctx, a);
    });
  }

  @Post('recordings/:rid/stop')
  @RequirePermission('assembly.view')
  async stopRecording(@Ctx() ctx: ReqCtx, @Param('rid', ParseUUIDPipe) rid: string) {
    return this.db.tx(dbc(ctx), (q) => this.media.stopRecording(q, ctx, rid));
  }
}

/**
 * Webhooks do LiveKit (application/webhook+json). A autenticidade é verificada pelo JWT do
 * cabeçalho Authorization, assinado com o segredo da API e contendo o SHA-256 do corpo.
 */
@Controller('webhooks')
export class MediaWebhookController {
  constructor(
    private readonly lk: LivekitService,
    private readonly media: MediaService,
  ) {}

  @Public()
  @Post('livekit')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  async livekit(@Req() req: AppRequest, @Headers('authorization') auth?: string) {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : '';
    if (!raw) throw new UnauthorizedException('Corpo do webhook ausente');
    let ev;
    try {
      ev = await this.lk.receiveWebhook(raw, auth);
    } catch {
      throw new UnauthorizedException('Assinatura do webhook inválida');
    }
    return this.media.handleWebhook(ev);
  }
}
