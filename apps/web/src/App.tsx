import { Spin } from 'antd';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { useAuth } from './lib/auth';
import { AssembliesPage } from './pages/AssembliesPage';
import { AssemblyDetailPage } from './pages/AssemblyDetailPage';
import { AuditPage } from './pages/AuditPage';
import { ConvocationPublicPage } from './pages/ConvocationPublicPage';
import { CondominiumDetailPage } from './pages/CondominiumDetailPage';
import { CondominiumsPage } from './pages/CondominiumsPage';
import { DashboardPage } from './pages/DashboardPage';
import { LoginPage } from './pages/LoginPage';
import { PlatformPage } from './pages/PlatformPage';
import { SecurityPage } from './pages/SecurityPage';
import { UsersPage } from './pages/UsersPage';
import { VoterRoomPage } from './pages/VoterRoomPage';

// Telas com dados de um cliente: sem cliente selecionado (ex.: superadministrador, que não pertence a nenhum, abrindo
// um endereço que ficou de outra sessão) voltam ao Painel em vez de exibir o erro da API.
function TenantRoutes() {
  const { tenant } = useAuth();
  return tenant ? <Outlet /> : <Navigate to="/" replace />;
}

export function App({ dark, onToggleTheme }: { dark: boolean; onToggleTheme: () => void }) {
  const { status, me } = useAuth();
  if (status === 'loading') {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <Spin size="large" tip="Carregando…">
          <div style={{ width: 80, height: 80 }} />
        </Spin>
      </div>
    );
  }
  if (status === 'anonymous') {
    return (
      <Routes>
        <Route path="/c/:token" element={<ConvocationPublicPage />} />
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  if (me?.user.mfaEnrollmentRequired) {
    return (
      <Routes>
        <Route element={<AppLayout dark={dark} onToggleTheme={onToggleTheme} />}>
          <Route path="*" element={<SecurityPage enrollmentRequired />} />
        </Route>
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/sala/:id" element={<VoterRoomPage />} />
      <Route path="/c/:token" element={<ConvocationPublicPage />} />
      <Route element={<AppLayout dark={dark} onToggleTheme={onToggleTheme} />}>
        <Route index element={<DashboardPage />} />
        <Route path="plataforma" element={<PlatformPage />} />
        <Route element={<TenantRoutes />}>
          <Route path="condominios" element={<CondominiumsPage />} />
          <Route path="condominios/:id" element={<CondominiumDetailPage />} />
          <Route path="assembleias" element={<AssembliesPage />} />
          <Route path="assembleias/:id" element={<AssemblyDetailPage />} />
          <Route path="usuarios" element={<UsersPage />} />
          <Route path="auditoria" element={<AuditPage />} />
        </Route>
        <Route path="seguranca" element={<SecurityPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
