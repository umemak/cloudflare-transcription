import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { Container, getContainer } from '@cloudflare/containers'
import { renderer } from './renderer'
import { appJs } from './static/app'

// ============================================================
// Container class - FFmpeg + transcription processing server
// ============================================================
export class TranscriptionContainer extends Container {
  defaultPort = 8080
  sleepAfter = '5m'  // Stop if idle for 5 minutes

  override onStart() {
    console.log('[Container] Transcription container started')
  }

  override onStop() {
    console.log('[Container] Transcription container stopped')
  }

  override onError(error: unknown) {
    console.error('[Container] Error:', error)
  }
}

// ============================================================
// AI helper: Generate summary using gpt-oss-120b
// ============================================================
async function generateSummary(transcript: string, ai: Ai): Promise<string> {
  try {
    console.log('[Summary] Starting summary generation with gpt-oss-120b')
    const response = await ai.run('@cf/openai/gpt-oss-120b', {
      input: `以下の文字起こしテキストを読んで、3〜5個の箇条書きで簡潔に要約してください。\n\n${transcript}`
    }) as any

    let summaryText = ''
    if (Array.isArray(response)) {
      summaryText = response.map((item: any) => {
        if (typeof item === 'string') return item
        if (item.text) return item.text
        if (item.content) return item.content
        return JSON.stringify(item)
      }).join('\n')
    } else if (response.response) {
      summaryText = Array.isArray(response.response)
        ? response.response.map((item: any) => item.text || item.content || String(item)).join('\n')
        : String(response.response)
    } else if (response.output) {
      summaryText = Array.isArray(response.output)
        ? response.output.map((item: any) => item.text || item.content || String(item)).join('\n')
        : String(response.output)
    } else if (response.text) {
      summaryText = response.text
    } else if (response.content) {
      summaryText = Array.isArray(response.content)
        ? response.content.map((item: any) => item.text || item.content || String(item)).join('\n')
        : String(response.content)
    } else if (response.choices?.[0]?.message?.content) {
      summaryText = response.choices[0].message.content
    } else if (typeof response === 'string') {
      summaryText = response
    } else {
      return '要約を生成できませんでした。'
    }

    return summaryText || '要約を生成できませんでした。'
  } catch (error) {
    console.error('[Summary] Error:', error)
    return `要約の生成中にエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`
  }
}

// ============================================================
// Utility functions
// ============================================================
function base64Encode(buffer: ArrayBuffer): string {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

async function hashPassword(password: string): Promise<string> {
  const data = new TextEncoder().encode(password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function generateSessionToken(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('')
}

// ============================================================
// Type definitions
// ============================================================
type Bindings = {
  DB: D1Database
  AUDIO_BUCKET: R2Bucket
  AI: Ai
  TRANSCRIPTION_CONTAINER: DurableObjectNamespace<TranscriptionContainer>
}

type Variables = {
  userId?: number
  userEmail?: string
}

// ============================================================
// Hono App
// ============================================================
const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

app.use('/api/*', cors())

// --- Auth middleware (shared) ---
async function authMiddleware(c: any, next: () => Promise<void>) {
  const sessionToken = getCookie(c, 'session_token')
  if (!sessionToken) {
    return c.json({ error: 'Unauthorized - Please login' }, 401)
  }
  const [email] = sessionToken.split(':')
  try {
    const user = await c.env.DB.prepare('SELECT id, email FROM users WHERE email = ?')
      .bind(email).first() as { id: number; email: string } | null
    if (!user) {
      return c.json({ error: 'Unauthorized - Invalid session' }, 401)
    }
    c.set('userId', user.id)
    c.set('userEmail', user.email)
    await next()
  } catch (error) {
    console.error('Auth middleware error:', error)
    return c.json({ error: 'Database error during authentication' }, 500)
  }
}

app.use('/api/transcribe', authMiddleware)
app.use('/api/transcriptions', authMiddleware)
app.use('/api/transcriptions/*', authMiddleware)
app.use('/api/audio/*', authMiddleware)

// --- Frontend renderer ---
app.use(renderer)

// --- Pages ---
app.get('/login', (c) => {
  return c.render(
    <>
      <div className="auth-container">
        <div className="auth-box">
          <h1>🎙️ ログイン</h1>
          <form id="loginForm" className="auth-form">
            <div className="form-group">
              <label htmlFor="loginEmail">メールアドレス</label>
              <input type="email" id="loginEmail" required />
            </div>
            <div className="form-group">
              <label htmlFor="loginPassword">パスワード</label>
              <input type="password" id="loginPassword" required />
            </div>
            <button type="submit" className="auth-btn">ログイン</button>
          </form>
          <div id="loginStatus"></div>
          <p className="auth-link">
            アカウントをお持ちでない方は <a href="/signup">こちら</a>
          </p>
        </div>
      </div>
    </>
  )
})

app.get('/signup', (c) => {
  return c.render(
    <>
      <div className="auth-container">
        <div className="auth-box">
          <h1>🎙️ 新規登録</h1>
          <form id="signupForm" className="auth-form">
            <div className="form-group">
              <label htmlFor="signupEmail">メールアドレス</label>
              <input type="email" id="signupEmail" required />
            </div>
            <div className="form-group">
              <label htmlFor="signupPassword">パスワード</label>
              <input type="password" id="signupPassword" required minLength="8" />
            </div>
            <div className="form-group">
              <label htmlFor="signupPasswordConfirm">パスワード（確認）</label>
              <input type="password" id="signupPasswordConfirm" required minLength="8" />
            </div>
            <button type="submit" className="auth-btn">登録</button>
          </form>
          <div id="signupStatus"></div>
          <p className="auth-link">
            既にアカウントをお持ちの方は <a href="/login">こちら</a>
          </p>
        </div>
      </div>
    </>
  )
})

app.get('/', async (c) => {
  const sessionToken = getCookie(c, 'session_token')
  if (!sessionToken) return c.redirect('/login')

  const [email] = sessionToken.split(':')
  const user = await c.env.DB.prepare('SELECT id, email FROM users WHERE email = ?')
    .bind(email).first() as { id: number; email: string } | null
  if (!user) return c.redirect('/login')

  return c.render(
    <>
      <div className="container">
        <div className="header-bar">
          <div>
            <h1>🎙️ 音声文字起こしアプリ</h1>
            <p>音声ファイルをアップロードして、AIで自動文字起こしを行います</p>
          </div>
          <div className="user-info">
            <span className="user-email">{user.email}</span>
            <button id="logoutBtn" className="logout-btn">ログアウト</button>
          </div>
        </div>

        <div className="upload-section">
          <h2>音声ファイルをアップロード</h2>
          <input type="file" id="audioFile" accept="audio/*" />
          <div className="language-selector">
            <label htmlFor="language">言語:</label>
            <select id="language">
              <option value="ja">日本語</option>
              <option value="en">英語</option>
              <option value="zh">中国語</option>
              <option value="ko">韓国語</option>
              <option value="es">スペイン語</option>
              <option value="fr">フランス語</option>
              <option value="de">ドイツ語</option>
            </select>
          </div>
          <button id="uploadBtn">アップロードして文字起こし</button>
          <div id="uploadStatus"></div>
        </div>

        <div className="transcriptions-section">
          <h2>文字起こし履歴</h2>
          <button id="refreshBtn">更新</button>
          <div id="transcriptionsList"></div>
        </div>
      </div>

      <script dangerouslySetInnerHTML={{ __html: appJs }}></script>
    </>
  )
})

// ============================================================
// Auth API
// ============================================================
app.post('/api/signup', async (c) => {
  try {
    const formData = await c.req.formData()
    const email = formData.get('email') as string
    const password = formData.get('password') as string

    if (!email || !password) return c.json({ error: 'Email and password are required' }, 400)
    if (password.length < 8) return c.json({ error: 'Password must be at least 8 characters' }, 400)

    const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first()
    if (existingUser) return c.json({ error: 'User already exists' }, 400)

    const passwordHash = await hashPassword(password)
    await c.env.DB.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').bind(email, passwordHash).run()

    const sessionToken = `${email}:${generateSessionToken()}`
    setCookie(c, 'session_token', sessionToken, {
      path: '/', httpOnly: true, secure: true, sameSite: 'None', maxAge: 60 * 60 * 24 * 30
    })
    return c.json({ success: true, email })
  } catch (error) {
    console.error('Signup error:', error)
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500)
  }
})

app.post('/api/login', async (c) => {
  try {
    const formData = await c.req.formData()
    const email = formData.get('email') as string
    const password = formData.get('password') as string

    if (!email || !password) return c.json({ error: 'Email and password are required' }, 400)

    const user = await c.env.DB.prepare('SELECT id, email, password_hash FROM users WHERE email = ?')
      .bind(email).first() as { id: number; email: string; password_hash: string } | null
    if (!user) return c.json({ error: 'Invalid email or password' }, 401)

    const passwordHash = await hashPassword(password)
    if (passwordHash !== user.password_hash) return c.json({ error: 'Invalid email or password' }, 401)

    const sessionToken = `${user.email}:${generateSessionToken()}`
    setCookie(c, 'session_token', sessionToken, {
      path: '/', httpOnly: true, secure: true, sameSite: 'None', maxAge: 60 * 60 * 24 * 30
    })
    return c.json({ success: true, email: user.email })
  } catch (error) {
    console.error('Login error:', error)
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500)
  }
})

app.post('/api/logout', (c) => {
  deleteCookie(c, 'session_token')
  return c.json({ success: true })
})

// ============================================================
// Transcription API - Upload & dispatch to Container
// ============================================================
app.post('/api/transcribe', async (c) => {
  try {
    const formData = await c.req.formData()
    const audioFile = formData.get('audio') as File
    const language = formData.get('language') as string || 'ja'

    if (!audioFile) return c.json({ error: 'No audio file provided' }, 400)

    // 1. Upload to R2
    const timestamp = Date.now()
    const randomStr = Math.random().toString(36).substring(7)
    const fileKey = `audio/${timestamp}-${randomStr}-${audioFile.name}`

    const arrayBuffer = await audioFile.arrayBuffer()
    await c.env.AUDIO_BUCKET.put(fileKey, arrayBuffer, {
      httpMetadata: { contentType: audioFile.type }
    })

    // 2. Insert record into D1
    const userId = c.get('userId')
    const result = await c.env.DB.prepare(
      'INSERT INTO transcriptions (audio_file_key, audio_file_name, audio_file_size, status, user_id) VALUES (?, ?, ?, ?, ?)'
    ).bind(fileKey, audioFile.name, audioFile.size, 'processing', userId).run()

    const transcriptionId = result.meta.last_row_id

    // 3. Dispatch job to Container
    try {
      const container = getContainer(c.env.TRANSCRIPTION_CONTAINER, 'transcriber')

      // Build the Worker's own URL for callbacks
      const workerUrl = new URL(c.req.url).origin

      // Send job to container
      const containerResponse = await container.fetch(
        new Request('http://container/process', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            audioUrl: `${workerUrl}/api/internal/audio/${transcriptionId}`,
            audioFileName: audioFile.name,
            callbackUrl: workerUrl,
            transcriptionId: String(transcriptionId),
            language
          })
        })
      )

      if (!containerResponse.ok) {
        const errorText = await containerResponse.text()
        console.error('Container dispatch error:', errorText)
        throw new Error(`Container returned ${containerResponse.status}`)
      }

      console.log(`[Transcribe] Job dispatched to container for transcription ${transcriptionId}`)

    } catch (containerError) {
      console.error('Container dispatch failed, falling back to inline processing:', containerError)

      // Fallback: process inline (small files only)
      await processInline(c, transcriptionId, arrayBuffer, audioFile.name, language)
    }

    return c.json({
      id: transcriptionId,
      status: 'processing',
      message: '処理を開始しました。'
    }, 202)
  } catch (error) {
    console.error('Transcription error:', error)
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500)
  }
})

// Inline fallback for when Container is unavailable
async function processInline(c: any, transcriptionId: number, arrayBuffer: ArrayBuffer, fileName: string, language: string) {
  try {
    const base64Audio = base64Encode(arrayBuffer)
    const aiResponse = await c.env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: base64Audio
    }) as any

    const transcriptText = aiResponse.text || ''
    let vttText = ''
    if (aiResponse.segments?.length > 0) {
      vttText = 'WEBVTT\n\n'
      for (const seg of aiResponse.segments) {
        const fmtStart = formatTimeVTT(seg.start)
        const fmtEnd = formatTimeVTT(seg.end)
        vttText += `${fmtStart} --> ${fmtEnd}\n${seg.text}\n\n`
      }
    }

    const summary = await generateSummary(transcriptText, c.env.AI)

    await c.env.DB.prepare(
      'UPDATE transcriptions SET transcript_text = ?, vtt_text = ?, summary_text = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind(transcriptText, vttText, summary, 'completed', transcriptionId).run()

  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error'
    await c.env.DB.prepare(
      'UPDATE transcriptions SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind('failed', msg, transcriptionId).run()
  }
}

function formatTimeVTT(seconds: number): string {
  const H = String(Math.floor(seconds / 3600)).padStart(2, '0')
  const M = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
  const S = String(Math.floor(seconds % 60)).padStart(2, '0')
  const ms = String(Math.round((seconds % 1) * 1000)).padStart(3, '0')
  return `${H}:${M}:${S}.${ms}`
}

// ============================================================
// Internal API - called by Container (not exposed to users)
// ============================================================

// Container calls this to download audio
app.get('/api/internal/audio/:id', async (c) => {
  const id = c.req.param('id')
  const transcription = await c.env.DB.prepare('SELECT audio_file_key FROM transcriptions WHERE id = ?')
    .bind(id).first() as { audio_file_key: string } | null

  if (!transcription) return c.json({ error: 'Not found' }, 404)

  const object = await c.env.AUDIO_BUCKET.get(transcription.audio_file_key)
  if (!object) return c.json({ error: 'Audio file not found' }, 404)

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'audio/mpeg',
      'Content-Length': object.size.toString()
    }
  })
})

// Container calls this to run Whisper
app.post('/api/internal/whisper', async (c) => {
  try {
    const { audio, language } = await c.req.json()
    const aiResponse = await c.env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio
    }) as any

    return c.json({
      text: aiResponse.text || '',
      segments: aiResponse.segments || []
    })
  } catch (error) {
    console.error('Whisper error:', error)
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500)
  }
})

// Container calls this to generate summary
app.post('/api/internal/summarize', async (c) => {
  try {
    const { transcript } = await c.req.json()
    const summary = await generateSummary(transcript, c.env.AI)
    return c.json({ summary })
  } catch (error) {
    console.error('Summarize error:', error)
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500)
  }
})

// Container calls this to report progress
app.post('/api/internal/progress', async (c) => {
  try {
    const { transcriptionId, phase, message } = await c.req.json()
    await c.env.DB.prepare(
      'UPDATE transcriptions SET error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind(`${phase}: ${message}`, transcriptionId).run()
    return c.json({ ok: true })
  } catch (error) {
    return c.json({ error: 'Progress update failed' }, 500)
  }
})

// Container calls this with final results
app.post('/api/internal/callback', async (c) => {
  try {
    const body = await c.req.json()
    const { transcriptionId, status, transcript, vtt, summary, error: errorMsg } = body

    if (status === 'completed') {
      await c.env.DB.prepare(
        'UPDATE transcriptions SET transcript_text = ?, vtt_text = ?, summary_text = ?, status = ?, error_message = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).bind(transcript, vtt, summary, 'completed', transcriptionId).run()
      console.log(`[Callback] Transcription ${transcriptionId} completed`)
    } else {
      await c.env.DB.prepare(
        'UPDATE transcriptions SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).bind('failed', errorMsg || 'Unknown error', transcriptionId).run()
      console.log(`[Callback] Transcription ${transcriptionId} failed: ${errorMsg}`)
    }

    return c.json({ ok: true })
  } catch (error) {
    console.error('Callback error:', error)
    return c.json({ error: 'Callback processing failed' }, 500)
  }
})

// ============================================================
// User-facing API - status & data
// ============================================================

// Get all transcriptions
app.get('/api/transcriptions', async (c) => {
  try {
    const userId = c.get('userId')
    if (!userId) return c.json({ error: 'User not authenticated' }, 401)

    const result = await c.env.DB.prepare(
      'SELECT id, audio_file_key, audio_file_name, audio_file_size, transcript_text, vtt_text, summary_text, status, error_message, created_at, updated_at FROM transcriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50'
    ).bind(userId).all()

    return c.json({ transcriptions: result.results || [] })
  } catch (error) {
    console.error('Get transcriptions error:', error)
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500)
  }
})

// Get single transcription (for polling)
app.get('/api/transcriptions/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const userId = c.get('userId')

    const result = await c.env.DB.prepare(
      'SELECT id, audio_file_key, audio_file_name, audio_file_size, transcript_text, vtt_text, summary_text, status, error_message, created_at, updated_at FROM transcriptions WHERE id = ? AND user_id = ?'
    ).bind(id, userId).first()

    if (!result) return c.json({ error: 'Transcription not found' }, 404)
    return c.json(result)
  } catch (error) {
    console.error('Get transcription error:', error)
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500)
  }
})

// Stream audio file from R2
app.get('/api/audio/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const userId = c.get('userId')

    const transcription = await c.env.DB.prepare(
      'SELECT audio_file_key FROM transcriptions WHERE id = ? AND user_id = ?'
    ).bind(id, userId).first() as { audio_file_key: string } | null

    if (!transcription) return c.json({ error: 'Transcription not found' }, 404)

    const object = await c.env.AUDIO_BUCKET.get(transcription.audio_file_key)
    if (!object) return c.json({ error: 'Audio file not found' }, 404)

    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'audio/mpeg',
        'Content-Length': object.size.toString(),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000'
      }
    })
  } catch (error) {
    console.error('Stream audio error:', error)
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500)
  }
})

// Update VTT text
app.post('/api/transcriptions/:id/vtt', async (c) => {
  try {
    const id = c.req.param('id')
    const userId = c.get('userId')
    const formData = await c.req.formData()
    const vttText = formData.get('vtt_text') as string

    if (!vttText) return c.json({ error: 'No VTT text provided' }, 400)

    await c.env.DB.prepare(
      'UPDATE transcriptions SET vtt_text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
    ).bind(vttText, id, userId).run()

    return c.json({ success: true })
  } catch (error) {
    console.error('Update VTT error:', error)
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500)
  }
})

// Delete transcription
app.delete('/api/transcriptions/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const userId = c.get('userId')

    const transcription = await c.env.DB.prepare(
      'SELECT audio_file_key FROM transcriptions WHERE id = ? AND user_id = ?'
    ).bind(id, userId).first() as { audio_file_key: string } | null

    if (transcription) {
      await c.env.AUDIO_BUCKET.delete(transcription.audio_file_key)
    }

    await c.env.DB.prepare('DELETE FROM transcriptions WHERE id = ? AND user_id = ?').bind(id, userId).run()
    return c.json({ success: true })
  } catch (error) {
    console.error('Delete transcription error:', error)
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500)
  }
})

export default app
