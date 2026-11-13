# VPS de homologação (Hostinger KVM 2)

Ambiente **temporário**, acessado pelo IP, sem domínio e sem HTTPS.

| Item | Valor |
|---|---|
| Endereço | http://187.53.110.218 |
| Sistema | CentOS Stream 10 · 2 vCPU · 8 GB RAM · 100 GB |
| Pilha | Node 22 · PostgreSQL 18 (só localhost) · Nginx · systemd |
| SSH | `deploy@187.53.110.218`, porta 22, **somente chave** (login por senha desativado) |

## Acesso SSH

A chave privada (`lsglobal_vps`) é entregue fora do Git. Nunca a versione.

```bash
# Linux/macOS/Git Bash
cp lsglobal_vps ~/.ssh/ && chmod 600 ~/.ssh/lsglobal_vps
ssh -i ~/.ssh/lsglobal_vps deploy@187.53.110.218
```

Atalho opcional em `~/.ssh/config`:

```
Host lsglobal
    HostName 187.53.110.218
    User deploy
    IdentityFile ~/.ssh/lsglobal_vps
    IdentitiesOnly yes
```

- **PuTTY:** abra o PuTTYgen → *Load* → selecione `lsglobal_vps` → *Save private key* (.ppk) → use em *Connection › SSH › Auth*.
- **Bitvise:** *Client key manager* → *Import* → selecione `lsglobal_vps`.
- Impressão digital do servidor (ed25519): `SHA256:QKaEfNvCQagiSI7ZJ6bINOW22GrSAHCx2jda12Y7a6Q`

O usuário `deploy` tem `sudo` sem senha. O root também aceita a mesma chave, mas use `deploy`.

## Publicar uma nova versão

Da raiz do repositório (Git Bash):

```bash
bash infra/vps/deploy.sh           # build + migrações + reinício da API
bash infra/vps/deploy.sh --seed    # idem e recria os dados de demonstração
```

O script envia os arquivos do repositório (respeitando o `.gitignore`), roda `npm ci` e `npm run build` em
`/opt/lsglobal/app.new` enquanto a versão atual continua no ar, troca as pastas, aplica as migrações e reinicia a
API. A versão anterior fica em `/opt/lsglobal/app.old`.

## Layout no servidor

| Caminho | Conteúdo |
|---|---|
| `/opt/lsglobal/app` | versão no ar (dono: usuário de serviço `lsg`) |
| `/opt/lsglobal/shared/.env` | segredos gerados na 1ª instalação (chmod 600, fora do Git) |
| `/opt/lsglobal/storage` | arquivos, e-mails (`outbox/*.eml`) e gravações; persistem entre deploys |
| `/etc/systemd/system/lsglobal-api.service` | API Node em 127.0.0.1:3333 |
| `/etc/nginx/conf.d/lsglobal.conf` | front estático + proxy de `/api` e `/socket.io` |

## Operação

```bash
sudo systemctl status lsglobal-api          # estado da API
sudo journalctl -u lsglobal-api -f          # logs ao vivo
sudo systemctl restart lsglobal-api
sudo -u postgres psql lsglobal_assembleias  # console do banco
ls /opt/lsglobal/storage/outbox             # e-mails de convocação gerados (MAIL_DRIVER=file)
```

## Segurança aplicada

- SSH só por chave; root só por chave; fail2ban no sshd (5 tentativas → 1 h de bloqueio)
- firewalld liberando apenas 22, 80 e 443; Cockpit (9090) desativado
- PostgreSQL só em localhost, com scram-sha-256; a API usa o papel `lsg_app`, sem superusuário e sem BYPASSRLS
- API rodando com o usuário `lsg`, sem shell e com escrita apenas em `/opt/lsglobal/storage`

## Limitações deste ambiente (não é produção)

- **HTTP sem TLS:** por isso `NODE_ENV=development` (o cookie de sessão `secure` exigiria HTTPS). Câmera e
  microfone do navegador também só funcionam com HTTPS, então a transmissão (LiveKit) não está configurada.
- **Dados e usuários de demonstração** (seed) com a senha pública do README, e `MFA_ENFORCE_ADMIN=false`.
- Para produção: domínio + Let's Encrypt (`certbot --nginx`), `NODE_ENV=production`, `MFA_ENFORCE_ADMIN=true`,
  sem seed, SMTP real, backup do PostgreSQL e uma chave SSH por desenvolvedor.
