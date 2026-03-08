import { jsxRenderer } from 'hono/jsx-renderer'

export const renderer = jsxRenderer(({ children }) => {
  return (
    <html lang="ja">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>音声文字起こしアプリ</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <script src="/static/ffmpeg.js"></script>
        <script src="/static/ffmpeg-util.js"></script>
        <link href="/static/style.css" rel="stylesheet" />
      </head>
      <body className="bg-gray-50 min-h-screen">
        {children}
        <script src="/static/auth.js"></script>
      </body>
    </html>
  )
})
