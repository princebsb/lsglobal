import { LockOutlined, MailOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { Alert, Button, Card, Form, Input, Space, Typography } from 'antd';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { LoginSchema } from '@lsg/shared';
import { z } from 'zod';
import { api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';

type LoginForm = z.input<typeof LoginSchema>;

export function LoginPage() {
  const { completeLogin } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const { control, handleSubmit, formState } = useForm<LoginForm>({ resolver: zodResolver(LoginSchema), defaultValues: { email: '', password: '' } });

  const onLogin = handleSubmit(async (v) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ mfaRequired: boolean; mfaToken?: string; accessToken?: string }>('/auth/login', { method: 'POST', body: v, tenant: false });
      if (r.mfaRequired) setMfaToken(r.mfaToken!);
      else await completeLogin(r.accessToken!);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  });

  const onMfa = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ accessToken: string }>('/auth/mfa/verify', { method: 'POST', body: { mfaToken, code }, tenant: false });
      await completeLogin(r.accessToken);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-wrap">
      <Card className="login-card">
        <Space direction="vertical" size="large" style={{ width: '100%' }}>
          <Space align="center">
            <img src="/icon.svg" width={40} height={40} alt="" />
            <div>
              <Typography.Title level={4} style={{ margin: 0 }}>LS Global Assembleias</Typography.Title>
              <Typography.Text type="secondary">Acesso seguro</Typography.Text>
            </div>
          </Space>
          {error && <Alert type="error" showIcon message={error} role="alert" />}
          {!mfaToken ? (
            <Form layout="vertical" onSubmitCapture={onLogin} requiredMark={false}>
              <Form.Item label="E-mail" validateStatus={formState.errors.email ? 'error' : ''} help={formState.errors.email?.message}>
                <Controller
                  name="email"
                  control={control}
                  render={({ field }) => <Input {...field} prefix={<MailOutlined />} autoComplete="username" type="email" size="large" autoFocus />}
                />
              </Form.Item>
              <Form.Item label="Senha" validateStatus={formState.errors.password ? 'error' : ''} help={formState.errors.password?.message}>
                <Controller
                  name="password"
                  control={control}
                  render={({ field }) => <Input.Password {...field} prefix={<LockOutlined />} autoComplete="current-password" size="large" />}
                />
              </Form.Item>
              <Button type="primary" htmlType="submit" size="large" block loading={busy}>
                Entrar
              </Button>
            </Form>
          ) : (
            <Form layout="vertical" onSubmitCapture={onMfa}>
              <Typography.Paragraph>Informe o código de 6 dígitos do seu aplicativo autenticador.</Typography.Paragraph>
              <Form.Item label="Código MFA">
                <Input
                  prefix={<SafetyCertificateOutlined />}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  size="large"
                  autoFocus
                />
              </Form.Item>
              <Button type="primary" htmlType="submit" size="large" block loading={busy} disabled={code.length !== 6}>
                Verificar
              </Button>
            </Form>
          )}
          {import.meta.env.DEV && (
            <Alert
              type="info"
              message="Ambiente local de demonstração"
              description={
                <span>
                  Senha: <code>Demo@LSG2026</code> — usuários: admin@lsglobal.local, gestor@horizonte.demo, sindico@acacias.demo,
                  presidente@acacias.demo, credenciamento@acacias.demo, ana@acacias.demo, bruno@acacias.demo, marina@acacias.demo, admin@beta.demo
                </span>
              }
            />
          )}
        </Space>
      </Card>
    </main>
  );
}
