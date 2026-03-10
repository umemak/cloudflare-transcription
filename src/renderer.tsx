import { jsxRenderer } from 'hono/jsx-renderer'
import { authJs } from './static/auth'
import { styleCss } from './static/style'

export const renderer = jsxRenderer(({ children }) => {
  return (
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>音声文字起こしアプリ</title>
        <script src="https://cdn.tailwindcss.com"></script>
        {/* FFmpeg.wasmをCDNから読み込み（HTTPS環境のみ） */}
        <script src="https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js"></script>
        <script src="https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js"></script>
        <style dangerouslySetInnerHTML={{ __html: styleCss }}></style>
      </head>
      <body className="bg-gray-50 min-h-screen">
        {children}
        <script dangerouslySetInnerHTML={{ __html: authJs }}></script>
      </body>
    </html>
  )
})
