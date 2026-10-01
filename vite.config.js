import { defineConfig } from 'vite'

/**
 * Default: browser fetches the SubmitGame catalog directly from
 * raw.githubusercontent.com. The /catalog-proxy route retries that same
 * catalog only when direct access fails during Vite development.
 *
 * base: '/' — site is served at apex custom domain (games.omgithub.com), not a
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
        target: 'https://raw.githubusercontent.com/SubmitGame/Claude-vs-ChatGPT/main',
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
