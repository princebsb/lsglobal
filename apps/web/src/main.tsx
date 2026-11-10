import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider, theme } from 'antd';
import ptBR from 'antd/locale/pt_BR';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: true,
      staleTime: 5_000,
    },
  },
});

function readTheme(): boolean {
  try {
    const saved = localStorage.getItem('lsg.theme');
    if (saved) return saved === 'dark';
  } catch {
    /* sem armazenamento */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function Root() {
  const [dark, setDark] = useState(readTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try {
      localStorage.setItem('lsg.theme', dark ? 'dark' : 'light');
    } catch {
      /* sem armazenamento */
    }
  }, [dark]);
  return (
    <ConfigProvider
      locale={ptBR}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: '#1f4fbf', borderRadius: 8, fontFamily: "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
      }}
    >
      <AntApp>
        <QueryClientProvider client={queryClient}>
          <BrowserRouter>
            <AuthProvider>
              <App dark={dark} onToggleTheme={() => setDark((d) => !d)} />
            </AuthProvider>
          </BrowserRouter>
        </QueryClientProvider>
      </AntApp>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
