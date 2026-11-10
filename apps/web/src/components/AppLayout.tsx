import {
  AuditOutlined,
  BankOutlined,
  CalendarOutlined,
  DashboardOutlined,
  GlobalOutlined,
  LogoutOutlined,
  MoonOutlined,
  SafetyOutlined,
  SunOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { Alert, Avatar, Button, Dropdown, Grid, Layout, Menu, Select, Space, Tooltip, Typography } from 'antd';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useOnline } from '../lib/realtime';

export function AppLayout({ dark, onToggleTheme }: { dark: boolean; onToggleTheme: () => void }) {
  const { me, tenant, tenantId, selectTenant, can, logout } = useAuth();
  const loc = useLocation();
  const nav = useNavigate();
  const online = useOnline();
  const screens = Grid.useBreakpoint();

  const items = [
    { key: '/', icon: <DashboardOutlined />, label: <Link to="/">Painel</Link>, show: true },
    { key: '/plataforma', icon: <GlobalOutlined />, label: <Link to="/plataforma">Plataforma</Link>, show: can('platform.dashboard.view') },
    { key: '/condominios', icon: <BankOutlined />, label: <Link to="/condominios">Condomínios</Link>, show: !!tenant && can('condo.view') },
    { key: '/assembleias', icon: <CalendarOutlined />, label: <Link to="/assembleias">Assembleias</Link>, show: !!tenant && can('assembly.view') },
    { key: '/usuarios', icon: <TeamOutlined />, label: <Link to="/usuarios">Usuários</Link>, show: !!tenant && can('tenant.users.manage') },
    { key: '/auditoria', icon: <AuditOutlined />, label: <Link to="/auditoria">Auditoria</Link>, show: !!tenant && can('audit.view') },
    { key: '/seguranca', icon: <SafetyOutlined />, label: <Link to="/seguranca">Segurança da conta</Link>, show: true },
  ].filter((i) => i.show);

  const selected = items
    .map((i) => i.key)
    .filter((k) => (k === '/' ? loc.pathname === '/' : loc.pathname.startsWith(k)))
    .sort((a, b) => b.length - a.length)[0];

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Layout.Sider breakpoint="lg" collapsedWidth={screens.xs ? 0 : 64} width={232} theme="dark" aria-label="Navegação principal">
        <div className="brand">
          <img src="/icon.svg" alt="" width={28} height={28} />
          <span>LS Global</span>
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={selected ? [selected] : []} items={items.map(({ show: _s, ...i }) => i)} />
      </Layout.Sider>
      <Layout>
        <Layout.Header className="app-header">
          <Space wrap>
            {me && me.tenants.length > 0 && (
              <Select
                aria-label="Cliente ativo"
                value={tenantId ?? undefined}
                style={{ minWidth: 240 }}
                onChange={(v) => {
                  selectTenant(v);
                  nav('/');
                }}
                options={me.tenants.map((t) => ({ value: t.id, label: t.name }))}
                placeholder="Selecione o cliente"
              />
            )}
          </Space>
          <Space>
            <Tooltip title={dark ? 'Tema claro' : 'Tema escuro'}>
              <Button type="text" aria-label="Alternar tema" icon={dark ? <SunOutlined /> : <MoonOutlined />} onClick={onToggleTheme} />
            </Tooltip>
            <Dropdown
              menu={{
                items: [
                  { key: 'email', label: me?.user.email, disabled: true },
                  { key: 'logout', icon: <LogoutOutlined />, label: 'Sair', onClick: () => logout() },
                ],
              }}
            >
              <Button type="text" aria-label="Menu do usuário">
                <Space>
                  <Avatar size="small" icon={<UserOutlined />} />
                  {screens.md && <Typography.Text>{me?.user.fullName}</Typography.Text>}
                </Space>
              </Button>
            </Dropdown>
          </Space>
        </Layout.Header>
        {!online && (
          <Alert banner type="error" message="Sem conexão com a internet. Nenhum voto é aceito sem confirmação do servidor." />
        )}
        <Layout.Content id="conteudo" className="app-content" tabIndex={-1}>
          <Outlet />
        </Layout.Content>
        <Layout.Footer style={{ textAlign: 'center', fontSize: 12 }}>
          LS Global Tecnologia — LS Global Assembleias · Ambiente {import.meta.env.MODE}
        </Layout.Footer>
      </Layout>
    </Layout>
  );
}
