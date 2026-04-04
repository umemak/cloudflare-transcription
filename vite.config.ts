import build from '@hono/vite-build/cloudflare-workers'
import devServer from '@hono/vite-dev-server'
import adapter from '@hono/vite-dev-server/cloudflare'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    build({
      emptyOutDir: false,
      external: ['cloudflare:workers', '@cloudflare/containers'],
      outputDir: 'dist',
      // Re-import TranscriptionContainer as named export for Durable Objects / Containers
      entryContentAfterHooks: [
        () => `
          const merged = {}
          const definedHandlers = new Set()
          for (const [file, app] of Object.entries(modules)) {
            for (const [key, handler] of Object.entries(app)) {
              if (key !== 'fetch') {
                if (definedHandlers.has(key)) {
                  throw new Error(\`Handler "\${key}" is defined in multiple entry files.\`);
                }
                definedHandlers.add(key)
                merged[key] = handler
              }
            }
          }
        `,
        () => `
          // Named exports for Durable Objects / Cloudflare Containers
          const namedExports = import.meta.glob(['/src/index.tsx'], { eager: true })
          const { TranscriptionContainer } = Object.values(namedExports)[0]
          export { TranscriptionContainer }
        `
      ],
      entryContentDefaultExportHook: (appName: string) =>
        `export default { ...merged, fetch: ${appName}.fetch }`
    }),
    devServer({
      adapter,
      entry: 'src/index.tsx'
    })
  ],
  build: {
    copyPublicDir: true
  },
  publicDir: 'public'
})
