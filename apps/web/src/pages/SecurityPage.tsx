import { App, Alert, Button, Card, Input, QRCode, Space, Steps, Typography } from 'antd';
import { useState } from 'react';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../components/ui';

export function SecurityPage({ enrollmentRequired = false }: { enrollmentRequired?: boolean }) {
  const { me, logout } = useAuth();
  const { message } = App.useApp();
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const start = async () => {
    setBusy(true);
    try {
      setSetup(await api('/auth/mfa/setup', { method: 'POST', tenant: false }));
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const enable = async () => {
    setBusy(true);
    try {
      const r = await api<{ message: string }>('/auth/mfa/enable', { method: 'POST', body: { code }, tenant: false });
      message.success(r.message);
      await logout();
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="Segurança da conta" subtitle={me?.user.email} />
      {enrollmentRequired && (
        <Alert
          style={{ marginBottom: 16 }}
          type="warning"
          showIcon
          message="Autenticação em dois fatores obrigatória"
          description="Seu perfil possui privilégios administrativos. Configure o MFA para continuar usando a plataforma."
        />
      )}
      <Card title="Autenticação em dois fatores (TOTP)">
        {me?.user.mfaEnabled ? (
          <Alert type="success" showIcon message="MFA habilitado para esta conta." />
        ) : (
          <Space direction="vertical" size="large" style={{ width: '100%' }}>
            <Steps
              current={setup ? 1 : 0}
              items={[{ title: 'Gerar segredo' }, { title: 'Ler QR Code e confirmar' }, { title: 'Novo login' }]}
            />
            {!setup ? (
              <Button type="primary" onClick={start} loading={busy}>
                Configurar MFA
              </Button>
            ) : (
              <Space direction="vertical">
                <Typography.Text>Leia o QR Code no aplicativo autenticador (Google Authenticator, Microsoft Authenticator, etc.).</Typography.Text>
                <QRCode value={setup.otpauthUri} bgColor="#fff" />
                <Typography.Text type="secondary">
                  Ou informe o segredo manualmente: <span className="mono">{setup.secret}</span>
                </Typography.Text>
                <Space.Compact>
                  <Input
                    aria-label="Código de 6 dígitos"
                    value={code}
                    inputMode="numeric"
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    style={{ width: 140 }}
                  />
                  <Button type="primary" onClick={enable} disabled={code.length !== 6} loading={busy}>
                    Confirmar
                  </Button>
                </Space.Compact>
              </Space>
            )}
          </Space>
        )}
      </Card>
    </>
  );
}
