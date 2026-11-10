import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AuthService, type AccessClaims } from '../auth/auth.service';
import { AuthzService } from '../authz/authz.service';
import type { AuthUser } from '../common/http';
import { env } from '../config/env';
import { DbService } from '../db/db.service';

interface SocketData {
  user: AuthUser;
  tenantId: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Canal de tempo real (Socket.IO). Envia apenas NOTIFICAÇÕES de mudança (ids e estados);
 * os clientes reconsultam a API REST, que é a fonte autoritativa (reconciliação).
 * Escala horizontal: configurar @socket.io/redis-adapter quando REDIS_URL estiver disponível.
 */
@WebSocketGateway({
  namespace: '/rt',
  cors: { origin: env().WEB_ORIGIN.split(','), credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger('Realtime');
  @WebSocketServer() server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly auth: AuthService,
    private readonly authz: AuthzService,
    private readonly db: DbService,
  ) {}

  async handleConnection(socket: Socket): Promise<void> {
    try {
      const { token, tenantId } = (socket.handshake.auth ?? {}) as { token?: string; tenantId?: string };
      if (!token || !tenantId || !UUID_RE.test(tenantId)) throw new Error('credenciais ausentes');
      const claims = await this.jwt.verifyAsync<AccessClaims>(token);
      if (claims.typ !== 'access' || claims.enr) throw new Error('token inválido');
      const user = await this.auth.loadAuthUser(claims);
      const member = user.assignments.some((a) => a.tenantId === tenantId);
      if (!member && !this.authz.permissions(user, null).has('platform.tenants.access')) throw new Error('sem acesso');
      (socket.data as SocketData) = { user, tenantId };
    } catch (err) {
      socket.emit('error', { message: 'Não autorizado' });
      socket.disconnect(true);
    }
  }

  @SubscribeMessage('join')
  async join(@ConnectedSocket() socket: Socket, @MessageBody() body: { assemblyId?: string }) {
    const data = socket.data as SocketData | undefined;
    if (!data?.user || !body?.assemblyId || !UUID_RE.test(body.assemblyId)) return { ok: false };
    const a = await this.db.tx({ tenantId: data.tenantId, userId: data.user.userId }, (q) =>
      q.maybe<{ condominium_id: string }>('select condominium_id from assemblies where id = $1', [body.assemblyId]),
    );
    if (!a || !this.authz.permissions(data.user, data.tenantId, a.condominium_id).has('assembly.view')) {
      return { ok: false };
    }
    await socket.join(this.room(data.tenantId, body.assemblyId));
    return { ok: true };
  }

  @SubscribeMessage('leave')
  async leave(@ConnectedSocket() socket: Socket, @MessageBody() body: { assemblyId?: string }) {
    const data = socket.data as SocketData | undefined;
    if (data && body?.assemblyId) await socket.leave(this.room(data.tenantId, body.assemblyId));
    return { ok: true };
  }

  emitAssembly(tenantId: string, assemblyId: string, event: string, payload: Record<string, unknown> = {}): void {
    if (!this.server) return;
    this.server.to(this.room(tenantId, assemblyId)).emit(event, { assemblyId, ...payload, at: new Date().toISOString() });
  }

  private room(tenantId: string, assemblyId: string) {
    return `t:${tenantId}:a:${assemblyId}`;
  }
}
