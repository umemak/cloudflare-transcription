import { jsxRenderer } from 'hono/jsx-renderer'
import { authJs } from './static/auth'
import { styleCss } from './static/style'
import { ffmpegJs } from './static/ffmpeg'
import { ffmpegUtilJs } from './static/ffmpeg-util'

export const renderer = jsxRenderer(({ children }) => {
  return (
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>音声文字起こしアプリ</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script dangerouslySetInnerHTML={{ __html: ffmpegJs }}></script>
        <script dangerouslySetInnerHTML={{ __html: ffmpegUtilJs }}></script>
        <style dangerouslySetInnerHTML={{ __html: styleCss }}></style>
      </head>
      <body className="bg-gray-50 min-h-screen">
        {children}
        <script dangerouslySetInnerHTML={{ __html: authJs }}></script>
      </body>
    </html>
  )
})
