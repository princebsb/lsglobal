# 08 — Transmissão, palavra e gravação (LiveKit, sem Docker)

## O que está implementado

| Item | Onde |
|---|---|
| Token de sala emitido pela API, por papel | `POST /assemblies/:id/media/token` |
| Mesa/operação técnica: publica câmera, microfone e tela | identidade `staff:{userId}` |
| Condômino/procurador **credenciado**: assiste; publica só com a palavra | identidade `p:{personId}` |
| Fiscal (`audit.view`): assiste | identidade `obs:{userId}` |
| Fila de palavra: pedir, cancelar, conceder (com tempo), negar, encerrar | `POST /assemblies/:id/floor`, `/floor/:id/decision` |
| Permissão de publicação aplicada na sala em tempo real | `RoomService.updateParticipant` |
| Gravação composta (Egress) em MP4 | `POST /assemblies/:id/recordings/start`, `/recordings/:id/stop` |
| Início da gravação **só** após confirmação do servidor de mídia | webhook `egress_started` |
| SHA-256 do arquivo final; gravação concluída é imutável | webhook `egress_ended` + trigger |
| Falha de gravação: alerta para a mesa e registro na linha do tempo | `recording.failed` |
| Conexão/desconexão de participantes remotos como evidência de presença | `attendance_events` (`connect`/`disconnect`) |
| Webhooks com assinatura verificada e processamento idempotente | `POST /webhooks/livekit`, `media_webhook_events` |
| Reconexão automática do vídeo | `livekit-client` + `ConnectionStateToast` |

Os testes automatizados (`apps/api/test/media.e2e-spec.ts`) simulam o servidor de mídia.

**Validado com LiveKit Server 1.13.11 real (Windows, 05/11/2026):** emissão de tokens, entrada da mesa e de
condômino credenciado, webhooks assinados (`room_started`, `participant_joined`) aceitos e gravados, lista de
conectados via RoomService, e palavra concedida e retirada em tempo real (controles de microfone/câmera aparecem e
somem sem reconectar). **Não validados:** áudio/vídeo reais entre máquinas, rede externa/TURN e gravação (Egress).

**Pilha WSL2 instalada (05/11/2026):** distro `LSG` (Ubuntu 24.04) em `D:\wsl\lsg`; Redis, LiveKit Server 1.13.11
(Linux) e Egress v1.15.0 compilado sobem com `start-media.sh` (Egress `service ready`, PulseAudio ativo). O WSL
alcança a API do Windows na porta 3333 sem regra extra de firewall.

**Gravação validada de ponta a ponta (05/11/2026)**, na assembleia 2026-002 com um participante sintético
(`lk room join --publish-demo`): `POST /recordings/start` → webhook `egress_started` → `active` → `stop` →
webhook `egress_ended` → `complete`. MP4 de 16 s (H.264 1280×720 a 30 fps + AAC estéreo) gravado em
`apps/api/storage/recordings/...`; SHA-256 recalculado no Windows igual ao registrado; linha do tempo
`recording.requested/started/ended`; cadeia de auditoria íntegra. O caminho de falha também foi exercido
(`egress_ended` com erro → `failed` + motivo). Na sequência, a mesa diretora gravou pela interface web com
**câmera e microfone reais** (20 s): fala audível de 1 s a 11 s (RMS −20 a −30 dBFS, pico −3,7 dBFS, sem
saturação), vídeo da câmera presente e SHA-256 conferido.

**Vários participantes com palavra (05/11/2026, 50 s):** mesa (câmera + microfone), condômina `ana@` (assistindo pela
sala do participante) e um participante sintético só com vídeo. Sequência registrada: `floor.requested` →
gravação iniciada → `floor.granted` (permissão de publicação aplicada pelo LiveKit) → microfone da ana publicado
→ gravação encerrada → `floor.ended` (permissão retirada, faixa despublicada). O MP4 tem layout com a mesa e o
participante sintético, e fala nos dois trechos esperados; SHA-256 conferido. Como mesa e ana usaram o mesmo
microfone físico, o arquivo não permite atribuir cada trecho a um deles: para isso, repetir com duas máquinas.
**Duas máquinas na rede local (06/11/2026, via HTTPS):** mesa no PC do servidor e `ana@` em outro PC; câmeras e
microfones dos dois no MP4, com o layout `speaker` alternando o destaque conforme quem fala (prova de que o áudio de
cada um chegou separado).

**Gravação longa (06/11/2026): 35 min 13 s**, 791 MB (~3 Mbit/s, ~1,35 GB por hora), SHA-256 conferido, MP4 com
índice válido (navegável). Áudio contínuo até o último segundo, sem minuto mudo; vídeo vivo e alternando até o fim;
nenhum aviso do Egress no período. Planejar disco: uma assembleia de 3 h gera ~4 GB.

- Celular (Chrome Android) na LAN via `https://<IP do PC>:5173`: entra, recebe a palavra e publica microfone e câmera; vídeo em retrato e voz aparecem no MP4 (teste de 25 s, 06/11/2026). Ao ganhar a palavra, o destaque fica preto ~1–2 s até chegar o primeiro quadro da câmera.

Ainda não validados: rede externa/TURN e carga com muitos participantes.

Problemas do WSL resolvidos nos scripts (se reaparecerem, comece por aqui):
- `page load error: websocket url timeout reached`: o WSLg monta `/tmp/.X11-unix` somente leitura e o Xvfb do Egress
  não cria o display; além disso, sem cache do registro do GStreamer, o Chrome não abre em 20 s.
  O `start-media.sh` desmonta esse ponto na distro e pré-aquece o cache.
- `could not create element: faac`: o GStreamer do Ubuntu não traz o codificador AAC; o `setup-media.sh` compila
  só esse plugin a partir do `gst-plugins-bad` da mesma versão (hash conferido).

### Instalação local usada no desenvolvimento
- Binário: `D:\livekit\bin\livekit-server.exe` (checksum SHA-256 conferido com o `checksums.txt` oficial).
- Configuração: `D:\livekit\livekit.yaml` (chave `lsgdev`; segredo gerado aleatoriamente; só escuta em 127.0.0.1).
- Iniciar: `D:\livekit\bin\livekit-server.exe --config D:\livekit\livekit.yaml`

## Instalar o LiveKit Server nativamente

O LiveKit Server é um binário único em Go, com builds oficiais para Windows, Linux e macOS. Baixe na página de
releases oficial do projeto (github.com/livekit/livekit) e confira o checksum publicado.

Crie `livekit.yaml` fora do repositório. As chaves são segredos e não devem ser versionadas:

```yaml
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: false      # true em servidor com IP público
keys:
  lsgdev: <segredo com 32+ caracteres>
webhook:
  api_key: lsgdev
  urls:
    - http://localhost:3333/api/v1/webhooks/livekit
```

Inicie o servidor:

```
livekit-server --config livekit.yaml
```

Depois, no `.env` da API:

```
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=lsgdev
LIVEKIT_API_SECRET=<o mesmo segredo>
```

> O modo `--dev` usa a chave `devkey` com o segredo `secret`. A API recusa esse segredo, porque exige no mínimo
> 32 caracteres; por isso use o arquivo de configuração acima.

## Gravação (Egress)

O LiveKit Egress precisa de Linux com Chrome/GStreamer e de um Redis compartilhado com o LiveKit Server.
**Não há build nativo para Windows.** Sem Docker, as opções são:

- Servidor Linux, com o binário do Egress como serviço systemd. É a opção recomendada para produção.
- WSL2 (Ubuntu) na máquina Windows, para desenvolvimento.

Com o Egress ativo:

1. Defina `LIVEKIT_EGRESS_ENABLED=true`.
2. Faça `RECORDINGS_DIR` apontar para um diretório que **tanto o Egress quanto a API** acessem pelo mesmo caminho.
   A API só calcula o SHA-256 de arquivos dentro desse diretório. Se o arquivo estiver em outro lugar ou em S3,
   a gravação é registrada sem hash e com aviso.


### Gravação via WSL2 (sem Docker, tudo no D:)

Scripts em `infra/wsl/`:

1. Pré-requisito (uma vez, como administrador, com reinício): habilitar a Plataforma de Máquina Virtual
   (`wsl.exe --install --no-distribution`).
2. Importar o Ubuntu 24.04 oficial em `D:\wsl\lsg`: `wsl --import LSG D:\wsl\lsg D:\wsl\dl\ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz --version 2`.
   O `%USERPROFILE%\.wslconfig` coloca o swap em `D:\wsl\swap.vhdx` e limita a 8 GB de RAM.
3. `wsl -d LSG -u root -- bash "/mnt/d/LS GLOBAL/infra/wsl/setup-media.sh"`: instala Redis, GStreamer 1.24, Chrome,
   Go 1.26.8 e Node, compila o Egress v1.15.0 e instala o LiveKit Server para Linux.
4. No `.env`: `LIVEKIT_EGRESS_ENABLED=true`, `RECORDINGS_DIR=D:/LS GLOBAL/apps/api/storage/recordings` e
   `EGRESS_RECORDINGS_DIR=/mnt/d/LS GLOBAL/apps/api/storage/recordings`. A API converte o caminho entre os dois sistemas.

#### Topologia em uso: LiveKit no Windows, Redis + Egress no WSL (`LIVEKIT_SERVER_HOST=windows`)

O WSL2 do Windows 10 (modo NAT, sem rede espelhada) não repassa UDP da rede local, e o `netsh portproxy` só repassa
TCP. Com o LiveKit no WSL, um celular na rede conectava, mas o Chrome do próprio PC não estabelecia a mídia. Por isso
o LiveKit roda **nativo no Windows** e usa o Redis do WSL (`127.0.0.1:6379`, pelo encaminhamento de localhost do WSL).
O Egress continua no WSL e conecta no LiveKit pelo gateway do WSL (`ws://172.23.64.1:7880`).

Configuração uma vez:
- `powershell -ExecutionPolicy Bypass -File "D:\LS GLOBAL\infra\windows\firewall-livekit.ps1"` **como administrador**:
  libera o `livekit-server.exe` (TCP 7880/7881, UDP 50000–50200) só para sub-redes locais (LAN e rede do WSL).
- `.env`: `LIVEKIT_SERVER_HOST=windows`, `LIVEKIT_URL=ws://localhost:7880` (API → LiveKit) e
  `LIVEKIT_PUBLIC_URL=ws://<IP do PC na LAN>:7880` (navegadores, inclusive celulares). `WEB_ORIGIN` deve incluir
  `http://<IP do PC>:5173`.

A cada início (nesta ordem):
1. `wsl -d LSG -u root -- bash "/mnt/d/LS GLOBAL/infra/wsl/start-media.sh"` (Redis + Egress; encerra um LiveKit do WSL).
2. `powershell -ExecutionPolicy Bypass -File "D:\LS GLOBAL\infra\windows\start-livekit.ps1"` (gera `D:\livekit\livekit.yaml`
   a partir do `.env`, fora do repositório, e inicia o LiveKit; log em `D:\livekit\livekit.log`).
3. `npm run dev`.

Neste modo o `egress.yaml` recebe `insecure: true`: sem isso, o Chrome do Egress bloqueia `ws://` para um IP privado
(Local Network Access) e a gravação falha com `Start signal not received`. A opção vale só para o Chrome interno do
Egress e só em desenvolvimento.

**HTTPS na rede local (obrigatório para falar de outro dispositivo).** O navegador só libera microfone e câmera em
HTTPS ou `localhost`; a flag `unsafely-treat-insecure-origin-as-secure` não existe mais no Chrome 156. Por isso:
- Certificado de desenvolvimento em `<raiz>/.certs/dev-cert.pem` + `dev-key.pem` (fora do Git), válido para o IP do PC,
  `localhost` e `127.0.0.1`. Com ele presente, o Vite serve em `https://`. Gerar (no WSL):
  `openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=LS Global dev" -addext "subjectAltName=IP:<IP do PC>,IP:127.0.0.1,DNS:localhost" -keyout .certs/dev-key.pem -out .certs/dev-cert.pem`
- O Vite repassa `/rtc` (sinalização do LiveKit) para `localhost:7880`, então `LIVEKIT_PUBLIC_URL=wss://<IP do PC>:5173`:
  uma página HTTPS não pode abrir `ws://`. A mídia segue direta por UDP com o LiveKit.
- `WEB_ORIGIN` inclui as variantes `https://`.
- Todos (mesa inclusive) acessam `https://<IP do PC>:5173` e aceitam uma vez o aviso de certificado
  (Avançado → Continuar). A sala avisa "Microfone e câmera bloqueados pelo navegador" quando a página não é segura.

**Disco virtual do WSL em HD mecânico (D:).** A falha intermitente `page load error: websocket url timeout reached`
tinha como causa o Chrome do Egress criar um perfil novo no HD a cada gravação: de 5 s a 35 s, conforme a carga do
disco, contra prazos fixos de 15–20 s do Egress. Correções no `start-media.sh`: perfil do Chrome em `/dev/shm`
(`chrome_flags.user-data-dir`, ~0,4 s; uma gravação por vez neste ambiente) e Chrome/Egress/GStreamer travados na RAM
com `vmtouch`. O MP4 continua no disco (o Egress grava em `/home/egress/tmp` e depois move). Medido depois: ~2,7 s do
pedido ao início, em três gravações seguidas. Na API, o pedido de início tem prazo de 60 s e, se estourar, as gravações
ativas da sala no Egress são encerradas (evita gravação órfã sem registro, que ocupava CPU e bloqueava as próximas).

Com `LIVEKIT_SERVER_HOST=wsl` (padrão), o `start-media.sh` sobe também o LiveKit Linux no WSL; só o próprio PC conecta.

## Produção

- Use TLS (`wss://`) no endereço público (`LIVEKIT_PUBLIC_URL`), atrás de proxy reverso ou com o TLS do próprio LiveKit.
- Libere UDP 50000–60000 e TCP 7881. Para redes restritivas, configure TURN.
- A capacidade (participantes simultâneos, qualidade e custo de banda) **precisa de teste de carga** antes de qualquer
  compromisso comercial.
- Mantenha um procedimento de contingência: se a gravação falhar, a mesa recebe alerta, e a falha fica na linha do
  tempo e na auditoria.

## Pendências

- Ingestão RTMP/WHIP de equipamentos externos (mesa de som/vídeo do evento presencial).
- Reprodução da gravação sincronizada com a linha do tempo.
- Upload da gravação para object storage (S3), com hash conferido após o upload.
- Painel técnico com métricas de qualidade (perda de pacotes, bitrate) por participante.

## Teste em rede externa (pinggy.bat)

Para participantes fora da rede local (celular no 4G, outra casa), sem servidor com IP público:

1. Suba a pilha normal (start-media.sh → start-livekit.ps1 → `npm run dev`).
2. Rode `pinggy.bat` na raiz. Ele chama `infra/windows/pinggy-publico.ps1`, que:
   - inicia o relay TURN (`infra/wsl/start-turn.sh`, coturn no WSL, TCP 3478) com senha nova a cada execução. O relay só encaminha para o LiveKit (Windows); qualquer outro destino é recusado (403);
   - abre dois túneis do Pinggy: o `ssh` do domínio próprio (www.hellou.com.br, com `x:localServerTls` porque o Vite é HTTPS) para a página, a API, o Socket.IO e `/rtc`, e um túnel TCP para o relay: primeiro tenta `<chave>+tcp`; como segundo túnel da mesma chave o Pinggy não devolve endereço, então cai para o gratuito (`tcp@free.pinggy.io`, até 60 min, renovado sozinho). O domínio próprio fica com o primeiro túnel que usa a chave, por isso a página sobe antes; se um túnel cair, o script reabre os dois nessa ordem e reinicia o LiveKit com a nova porta;
   - reinicia o LiveKit com `rtc.turn_servers` apontando para o túnel TCP;
   - ao sair (tecla S), fecha os túneis, para o relay e reinicia o LiveKit só para a rede local.
3. Quem está fora abre `https://www.hellou.com.br` (domínio próprio ligado ao token no painel do Pinggy). O certificado é válido, então microfone e câmera funcionam.

Caminho da mídia externa: navegador → TURN/TCP (Pinggy) → coturn (WSL) → UDP → LiveKit. A rede local continua por UDP direto.

Em desenvolvimento, a web conecta ao LiveKit pelo próprio endereço da página (`wss://<host da página>/rtc`, repassado pelo Vite), seja localhost, IP da LAN ou túnel. Em produção, vale `LIVEKIT_PUBLIC_URL`.

Validado em 06/11/2026: celular no 4G por https://www.hellou.com.br, com a mídia pelo relay (par ICE `relay` no log do LiveKit). Voz e vídeo do celular aparecem no MP4.

Limitações: a mídia passa por TCP num servidor intermediário, então espere mais latência que em produção. Reiniciar o LiveKit derruba a sala por alguns segundos. O endereço é público enquanto a janela estiver aberta.
