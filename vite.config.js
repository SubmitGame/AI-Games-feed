import { defineConfig } from 'vite'

/**
 * Default: browser fetches catalog directly from raw.githubusercontent.com
 * (CORS ACAO: *). The /catalog-proxy route is only a Vite-dev fallback if
 * that direct fetch fails (documented in README).
 *
 * base: '/' — site is served at apex custom domain (lolgames.net), not a
 * project subpath.
 */
export default defineConfig({
  base: '/',
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/catalog-proxy': {
        target: 'https://raw.githubusercontent.com',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/catalog-proxy/, ''),
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
})
