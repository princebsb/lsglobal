/**
 * Palco de vídeo (LiveKit). Carregado sob demanda (React.lazy) para não pesar o restante da aplicação.
 * A reconexão é tratada pelo livekit-client; o estado é exibido por ConnectionStateToast.
 */
import '@livekit/components-styles';
import {
  ConnectionStateToast,
  ControlBar,
  GridLayout,
  LiveKitRoom,
  MediaDeviceMenu,
  ParticipantTile,
  RoomAudioRenderer,
  StartAudio,
  useLocalParticipantPermissions,
  useTracks,
} from '@livekit/components-react';
import { Alert, message } from 'antd';
import { MediaDeviceFailure, Track } from 'livekit-client';

const DEVICE_FAILURE: Record<string, string> = {
  [MediaDeviceFailure.PermissionDenied]: 'permissão negada no navegador. Libere o acesso pelo ícone ao lado do endereço.',
  [MediaDeviceFailure.NotFound]: 'nenhum dispositivo encontrado.',
  [MediaDeviceFailure.DeviceInUse]: 'o dispositivo está em uso por outro programa.',
};

function onDeviceFailure(failure?: MediaDeviceFailure, kind?: MediaDeviceKind) {
  const what = kind === 'videoinput' ? 'a câmera' : kind === 'audioinput' ? 'o microfone' : 'o dispositivo';
  message.error(`Não foi possível ativar ${what}: ${(failure && DEVICE_FAILURE[failure]) ?? 'erro desconhecido.'}`);
}

export interface MediaStageProps {
  url: string;
  token: string;
  staff: boolean;
  onLeave: () => void;
}

function Stage({ staff }: { staff: boolean }) {
  const perms = useLocalParticipantPermissions();
  const canPublish = staff || !!perms?.canPublish;
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );
  // No palco: quem publica algo, a mesa (metadados emitidos pela API) e o próprio usuário quando pode publicar.
  // Condôminos apenas assistindo não aparecem como quadros vazios.
  const isStaffParticipant = (metadata?: string) => {
    try {
      return JSON.parse(metadata || '{}').role === 'staff';
    } catch {
      return false;
    }
  };
  const visible = tracks.filter(
    (t) => t.publication || (t.participant.isLocal ? canPublish : isStaffParticipant(t.participant.metadata)),
  );
  // Fora de HTTPS/localhost o navegador não expõe microfone e câmera (navigator.mediaDevices fica indefinido),
  // e os botões não fariam nada sem avisar.
  const insecure = canPublish && (!window.isSecureContext || !navigator.mediaDevices);
  // Trocar a saída de áudio depende de setSinkId (Chrome/Edge; Safari e Firefox antigos não têm).
  const canChooseSpeaker = !!navigator.mediaDevices && 'setSinkId' in HTMLMediaElement.prototype;
  return (
    <div className="media-stage" data-lk-theme="default">
      {insecure && (
        <Alert
          type="warning"
          showIcon
          message="Microfone e câmera bloqueados pelo navegador"
          description="Esta página não está em conexão segura (HTTPS). Acesse pelo endereço HTTPS da plataforma para falar e aparecer no vídeo."
        />
      )}
      <div className="media-grid">
        {visible.length ? (
          <GridLayout tracks={visible}>
            <ParticipantTile />
          </GridLayout>
        ) : (
          <div className="media-waiting">Aguardando a mesa iniciar a transmissão…</div>
        )}
      </div>
      <RoomAudioRenderer />
      <StartAudio label="Clique para ativar o áudio" />
      <ConnectionStateToast />
      <ControlBar
        variation="minimal"
        controls={{ microphone: canPublish, camera: canPublish, screenShare: staff, chat: false, leave: true, settings: false }}
      />
      {/* Escolha explícita de dispositivos: o padrão do navegador nem sempre é o microfone/fone em uso. */}
      <div className="media-devices">
        {canPublish && !insecure && (
          <MediaDeviceMenu kind="audioinput" className="lk-button">
            🎤 Microfone
          </MediaDeviceMenu>
        )}
        {canChooseSpeaker && (
          <MediaDeviceMenu kind="audiooutput" className="lk-button">
            🔊 Alto-falante
          </MediaDeviceMenu>
        )}
      </div>
    </div>
  );
}

// Em desenvolvimento o Vite repassa /rtc ao LiveKit: a sinalização usa o mesmo endereço da página, seja localhost,
// o IP da rede local ou um túnel público (pinggy.bat). Em produção vale a URL informada pela API.
function serverUrl(url: string): string {
  if (!import.meta.env.DEV) return url;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
}

export default function MediaStage({ url, token, staff, onLeave }: MediaStageProps) {
  return (
    <LiveKitRoom serverUrl={serverUrl(url)} token={token} connect audio={false} video={false} onDisconnected={onLeave} onMediaDeviceFailure={onDeviceFailure} options={{ adaptiveStream: true, dynacast: true }}>
      <Stage staff={staff} />
    </LiveKitRoom>
  );
}
