import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import {
  AccessToken,
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  RoomServiceClient,
  TrackSource,
  WebhookReceiver,
  type VideoGrant,
  type WebhookEvent,
} from 'livekit-server-sdk';
import { env } from '../../config/env';

export interface MediaGrant {
  canPublish: boolean;
  canPublishData: boolean;
  /** Fontes permitidas quando canPublish (participante com a palavra: microfone e câmera). */
  sources?: ('camera' | 'microphone' | 'screen_share' | 'screen_share_audio')[];
  roomAdmin?: boolean;
  hidden?: boolean;
}

const SOURCE: Record<NonNullable<MediaGrant['sources']>[number], TrackSource> = {
  camera: TrackSource.CAMERA,
  microphone: TrackSource.MICROPHONE,
  screen_share: TrackSource.SCREEN_SHARE,
  screen_share_audio: TrackSource.SCREEN_SHARE_AUDIO,
};

/**
 * Integração com o LiveKit (servidor SFU auto-hospedado). Isola o SDK para que o domínio
 * dependa apenas desta fachada (e os testes possam substituí-la).
 */
@Injectable()
export class LivekitService {
  private readonly logger = new Logger('LiveKit');
  private rooms?: RoomServiceClient;
  private egress?: EgressClient;
  private receiver?: WebhookReceiver;

  configured(): boolean {
    const e = env();
    return Boolean(e.LIVEKIT_URL && e.LIVEKIT_API_KEY && e.LIVEKIT_API_SECRET);
  }

  egressEnabled(): boolean {
    return this.configured() && env().LIVEKIT_EGRESS_ENABLED;
  }

  /** URL WebSocket usada pelo navegador. */
  publicUrl(): string {
    const e = env();
    return e.LIVEKIT_PUBLIC_URL ?? e.LIVEKIT_URL!;
  }

  private ensure() {
    if (!this.configured()) {
      throw new ServiceUnavailableException({ message: 'Transmissão não configurada neste ambiente (LIVEKIT_URL/API_KEY/API_SECRET)', code: 'MEDIA_NOT_CONFIGURED' });
    }
    const e = env();
    const http = e.LIVEKIT_URL!.replace(/^ws/, 'http');
    this.rooms ??= new RoomServiceClient(http, e.LIVEKIT_API_KEY, e.LIVEKIT_API_SECRET);
    // O Egress só responde ao pedido de início depois de abrir o Chrome e o template de gravação, o que pode
    // levar dezenas de segundos em máquina lenta; o prazo padrão do SDK é curto demais para isso.
    this.egress ??= new EgressClient(http, e.LIVEKIT_API_KEY, e.LIVEKIT_API_SECRET, { requestTimeout: 60 });
    this.receiver ??= new WebhookReceiver(e.LIVEKIT_API_KEY!, e.LIVEKIT_API_SECRET!);
    return { rooms: this.rooms, egress: this.egress, receiver: this.receiver };
  }

  async token(room: string, identity: string, name: string, grant: MediaGrant, metadata: Record<string, unknown>, ttlSeconds = 900): Promise<string> {
    this.ensure();
    const e = env();
    const at = new AccessToken(e.LIVEKIT_API_KEY, e.LIVEKIT_API_SECRET, { identity, name, ttl: ttlSeconds, metadata: JSON.stringify(metadata) });
    const video: VideoGrant = {
      room,
      roomJoin: true,
      canSubscribe: true,
      canPublish: grant.canPublish,
      canPublishData: grant.canPublishData,
      canUpdateOwnMetadata: false,
      roomAdmin: grant.roomAdmin ?? false,
      hidden: grant.hidden ?? false,
    };
    if (grant.canPublish && grant.sources) video.canPublishSources = grant.sources.map((s) => SOURCE[s]);
    at.addGrant(video);
    return at.toJwt();
  }

  /**
   * Altera permissões de um participante já conectado (ex.: conceder/retirar a palavra).
   * Retorna false se o participante não estiver na sala ou o servidor estiver inacessível —
   * a decisão continua registrada e vale para o próximo token emitido.
   */
  async setPublish(room: string, identity: string, canPublish: boolean, sources: MediaGrant['sources'] = ['microphone', 'camera']): Promise<boolean> {
    const { rooms } = this.ensure();
    try {
      await rooms.updateParticipant(room, identity, {
        permission: {
          canSubscribe: true,
          canPublish,
          canPublishData: canPublish,
          canPublishSources: canPublish ? sources.map((s) => SOURCE[s]) : [],
        },
      });
      return true;
    } catch (err) {
      this.logger.warn(`updateParticipant(${room}, ${identity}) falhou: ${(err as Error).message}`);
      return false;
    }
  }

  async listParticipants(room: string) {
    const { rooms } = this.ensure();
    try {
      const list = await rooms.listParticipants(room);
      return list.map((p) => ({
        identity: p.identity,
        name: p.name,
        joinedAt: p.joinedAt ? new Date(Number(p.joinedAt) * 1000).toISOString() : null,
        tracks: p.tracks.map((t) => ({ source: TrackSource[t.source], muted: t.muted })),
        canPublish: p.permission?.canPublish ?? false,
      }));
    } catch {
      return null; // sala ainda não existe ou servidor inacessível
    }
  }

  /** Gravação composta da sala (Egress) em MP4. Retorna o id do egress. */
  async startRecording(room: string, filepath: string): Promise<string> {
    const { egress } = this.ensure();
    if (!this.egressEnabled()) {
      throw new ServiceUnavailableException({ message: 'Gravação em servidor não habilitada (LIVEKIT_EGRESS_ENABLED)', code: 'EGRESS_NOT_ENABLED' });
    }
    try {
      const info = await egress.startRoomCompositeEgress(room, new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath }), { layout: 'speaker' });
      return info.egressId;
    } catch (err) {
      // Sem resposta a tempo, o Egress pode ter iniciado mesmo assim: a gravação ficaria órfã (sem registro na API,
      // ocupando CPU e bloqueando as próximas). Quem chama já garantiu que não há gravação ativa registrada para
      // esta sala, então qualquer egress ativo nela é órfão.
      const orphans = await egress.listEgress({ roomName: room, active: true }).catch(() => []);
      for (const o of orphans) {
        this.logger.warn(`Encerrando gravação órfã ${o.egressId} da sala ${room} após falha no início`);
        await egress.stopEgress(o.egressId).catch(() => undefined);
      }
      this.logger.error(`Falha ao iniciar gravação na sala ${room}: ${(err as Error).message}`);
      throw new ServiceUnavailableException({
        message: 'O servidor de gravação não respondeu a tempo. Tente iniciar a gravação novamente.',
        code: 'EGRESS_START_FAILED',
      });
    }
  }

  async stopRecording(egressId: string): Promise<void> {
    const { egress } = this.ensure();
    await egress.stopEgress(egressId);
  }

  /** Valida assinatura (JWT com SHA-256 do corpo) e decodifica o webhook. */
  async receiveWebhook(body: string, authHeader: string | undefined): Promise<WebhookEvent> {
    const { receiver } = this.ensure();
    return receiver.receive(body, authHeader);
  }
}
