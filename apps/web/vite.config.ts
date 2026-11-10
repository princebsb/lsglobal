import react from '@vitejs/plugin-react';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const API = process.env.VITE_API_PROXY ?? 'http://localhost:3333';
const LIVEKIT = process.env.VITE_LIVEKIT_PROXY ?? 'http://localhost:7880';

// HTTPS de desenvolvimento: ativado quando existe o certificado em <raiz>/.certs (fora do Git).
// Necessário para microfone/câmera em outros dispositivos da rede: o navegador só os libera em HTTPS ou localhost.
const certDir = fileURLToPath(new URL('../../.certs/', import.meta.url));
const https =
  existsSync(`${certDir}dev-cert.pem`) && existsSync(`${certDir}dev-key.pem`)
    ? { cert: readFileSync(`${certDir}dev-cert.pem`), key: readFileSync(`${certDir}dev-key.pem`) }
    : undefined;

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'LS Global Assembleias',
        short_name: 'Assembleias',
        description: 'Assembleias presenciais, virtuais e híbridas',
        lang: 'pt-BR',
        theme_color: '#0f2a5c',
        background_color: '#ffffff',
        display: 'standalone',
        icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
      },
      workbox: {
        // Nunca armazenar respostas da API em cache: votos e quórum vêm sempre do servidor.
        navigateFallbackDenylist: [/^\/api/, /^\/socket\.io/],
        runtimeCaching: [],
      },
    }),
  ],
  resolve: {
    alias: {
      // o front consome o código-fonte TypeScript do pacote compartilhado (ESM)
      '@lsg/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    host: true, // escuta em 0.0.0.0 para acesso por outros dispositivos da rede local
    https,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/socket.io': { target: API, ws: true },
      // Sinalização do LiveKit pelo mesmo endereço (wss://<host>:5173/rtc): uma página HTTPS não pode abrir ws://.
      // A mídia (UDP/TCP) continua direta com o LiveKit. Usado quando LIVEKIT_PUBLIC_URL=wss://<host>:5173.
      '/rtc': { target: LIVEKIT, ws: true },
    },
  },
  build: { sourcemap: true, chunkSizeWarningLimit: 2000 },
});
