import build from '@hono/vite-build/cloudflare-workers'
import devServer from '@hono/vite-dev-server'
import adapter from '@hono/vite-dev-server/cloudflare'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    build({
      emptyOutDir: false,
      external: [],
      outputDir: 'dist'
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
