import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { renderer } from './renderer'
import { appJs } from './static/app'

// Generate summary using AI
async function generateSummary(transcript: string, ai: Ai): Promise<string> {
  try {
    console.log('[Summary] Starting summary generation with gpt-oss-120b')
    console.log('[Summary] Transcript length:', transcript.length)
    
    // gpt-oss-120bは Responses API形式を使用
    const response = await ai.run('@cf/openai/gpt-oss-120b', {
      input: `以下の文字起こしテキストを読んで、3〜5個の箇条書きで簡潔に要約してください。\n\n${transcript}`
    }) as any
    
    console.log('[Summary] Raw AI response:', JSON.stringify(response, null, 2))
    console.log('[Summary] Response type:', typeof response)
    console.log('[Summary] Response keys:', Object.keys(response || {}))
    
    // Responses API のレスポンス形式に対応
    let summaryText = ''
    
    // 配列の場合（複数のcontent部分がある可能性）
    if (Array.isArray(response)) {
      console.log('[Summary] Response is array, length:', response.length)
      // 配列の各要素からテキストを抽出
      summaryText = response.map(item => {
        if (typeof item === 'string') return item
        if (item.text) return item.text
        if (item.content) return item.content
        return JSON.stringify(item)
      }).join('\n')
    }
    // オブジェクトの場合
    else if (response.response) {
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
    } else if (response.choices && response.choices[0]?.message?.content) {
      summaryText = response.choices[0].message.content
    } else if (typeof response === 'string') {
      summaryText = response
    } else {
      console.error('[Summary] Unknown response format:', response)
      return '要約を生成できませんでした（レスポンス形式が不明）。'
    }
    
    console.log('[Summary] Extracted summary text:', summaryText)
    return summaryText || '要約を生成できませんでした。'
  } catch (error) {
    console.error('[Summary] Error:', error)
    console.error('[Summary] Error details:', JSON.stringify(error, null, 2))
    return `要約の生成中にエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`
  }
}

type Bindings = {
  DB: D1Database
  AUDIO_BUCKET: R2Bucket
  AI: Ai
}

type Variables = {
  userId?: number
  userEmail?: string
}

// Base64エンコード関数
function base64Encode(buffer: ArrayBuffer): string {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

// パスワードハッシュ化（SHA-256）
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

// セッショントークン生成
function generateSessionToken(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('')
}

// タイムスタンプをVTT形式にフォーマット（HH:MM:SS.mmm）
function formatTimeVTT(seconds: number): string {
  const pad = (num: number) => (num < 10 ? `0${num}` : num)
  
  const H = pad(Math.floor(seconds / 3600))
  const M = pad(Math.floor((seconds % 3600) / 60))
  const S = pad(Math.floor(seconds % 60))
  const ms = `${Math.round((seconds % 1) * 1000)}`.padStart(3, '0')
  
  return `${H}:${M}:${S}.${ms}`
}

// セグメント情報からVTTを生成
function generateVTT(segments: any[]): string {
  let vtt = 'WEBVTT\n\n'
  
  for (const segment of segments) {
    vtt += `${formatTimeVTT(segment.start)} --> ${formatTimeVTT(segment.end)}\n`
    vtt += `${segment.text}\n\n`
  }
  
  return vtt
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// Enable CORS for API routes
app.use('/api/*', cors())

// Note: COOP/COEP headers removed - using FFmpeg single-thread mode
// which doesn't require SharedArrayBuffer, avoiding cross-origin issues

// Auth middleware - check session for protected routes
app.use('/api/transcribe', async (c, next) => {
  const sessionToken = getCookie(c, 'session_token')
  
  if (!sessionToken) {
    return c.json({ error: 'Unauthorized - Please login' }, 401)
  }
  
  // Verify session token (stored as email:token format in cookie)
  const [email] = sessionToken.split(':')
  
  // Get user from database
  const user = await c.env.DB.prepare(`
    SELECT id, email FROM users WHERE email = ?
  `).bind(email).first() as { id: number; email: string } | null
  
  if (!user) {
    return c.json({ error: 'Unauthorized - Invalid session' }, 401)
  }
  
  // Set user info in context
  c.set('userId', user.id)
  c.set('userEmail', user.email)
  
  await next()
})

// Auth middleware for transcriptions endpoints
app.use('/api/transcriptions', async (c, next) => {
  const sessionToken = getCookie(c, 'session_token')
  
  console.log('Auth middleware for /api/transcriptions, session:', sessionToken ? 'present' : 'missing')
  
  if (!sessionToken) {
    return c.json({ error: 'Unauthorized - Please login' }, 401)
  }
  
  const [email] = sessionToken.split(':')
  console.log('Extracted email from session:', email)
  
  try {
    const user = await c.env.DB.prepare(`
      SELECT id, email FROM users WHERE email = ?
    `).bind(email).first() as { id: number; email: string } | null
    
    console.log('User lookup result:', user ? `Found user ${user.id}` : 'Not found')
    
    if (!user) {
      return c.json({ error: 'Unauthorized - Invalid session' }, 401)
    }
    
    c.set('userId', user.id)
    c.set('userEmail', user.email)
    console.log('Set userId in context:', user.id)
    
    await next()
  } catch (error) {
    console.error('Auth middleware error:', error)
    return c.json({ 
      error: 'Database error during authentication',
      details: error instanceof Error ? error.message : String(error)
    }, 500)
  }
})

app.use('/api/transcriptions/*', async (c, next) => {
  const sessionToken = getCookie(c, 'session_token')
  
  console.log('Auth middleware for /api/transcriptions*, session:', sessionToken ? 'present' : 'missing')
  
  if (!sessionToken) {
    return c.json({ error: 'Unauthorized - Please login' }, 401)
  }
  
  const [email] = sessionToken.split(':')
  console.log('Extracted email from session:', email)
  
  try {
    const user = await c.env.DB.prepare(`
      SELECT id, email FROM users WHERE email = ?
    `).bind(email).first() as { id: number; email: string } | null
    
    console.log('User lookup result:', user ? `Found user ${user.id}` : 'Not found')
    
    if (!user) {
      return c.json({ error: 'Unauthorized - Invalid session' }, 401)
    }
    
    c.set('userId', user.id)
    c.set('userEmail', user.email)
    console.log('Set userId in context:', user.id)
    
    await next()
  } catch (error) {
    console.error('Auth middleware error:', error)
    return c.json({ 
      error: 'Database error during authentication',
      details: error instanceof Error ? error.message : String(error)
    }, 500)
  }
})

app.use('/api/audio/*', async (c, next) => {
  const sessionToken = getCookie(c, 'session_token')
  
  if (!sessionToken) {
    return c.json({ error: 'Unauthorized - Please login' }, 401)
  }
  
  const [email] = sessionToken.split(':')
  
  const user = await c.env.DB.prepare(`
    SELECT id, email FROM users WHERE email = ?
  `).bind(email).first() as { id: number; email: string } | null
  
  if (!user) {
    return c.json({ error: 'Unauthorized - Invalid session' }, 401)
  }
  
  c.set('userId', user.id)
  c.set('userEmail', user.email)
  
  await next()
})

// Static files are served automatically by Cloudflare Workers assets

// Frontend renderer
app.use(renderer)

// Login page
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

// Signup page
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

// Home page (protected)
app.get('/', async (c) => {
  const sessionToken = getCookie(c, 'session_token')
  
  // Redirect to login if not authenticated
  if (!sessionToken) {
    return c.redirect('/login')
  }
  
  const [email] = sessionToken.split(':')
  const user = await c.env.DB.prepare(`
    SELECT id, email FROM users WHERE email = ?
  `).bind(email).first() as { id: number; email: string } | null
  
  if (!user) {
    return c.redirect('/login')
  }
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

// API: Signup
app.post('/api/signup', async (c) => {
  try {
    const formData = await c.req.formData()
    const email = formData.get('email') as string
    const password = formData.get('password') as string
    
    console.log('Signup attempt:', email)
    
    if (!email || !password) {
      return c.json({ error: 'Email and password are required' }, 400)
    }
    
    if (password.length < 8) {
      return c.json({ error: 'Password must be at least 8 characters' }, 400)
    }
    
    // Check if user already exists
    try {
      const existingUser = await c.env.DB.prepare(`
        SELECT id FROM users WHERE email = ?
      `).bind(email).first()
      
      if (existingUser) {
        return c.json({ error: 'User already exists' }, 400)
      }
    } catch (dbError) {
      console.error('Database error checking user:', dbError)
      return c.json({ 
        error: 'Database error. Users table may not exist. Please ensure migrations have been applied.',
        details: dbError instanceof Error ? dbError.message : 'Unknown database error'
      }, 500)
    }
    
    // Hash password
    const passwordHash = await hashPassword(password)
    
    // Create user
    try {
      await c.env.DB.prepare(`
        INSERT INTO users (email, password_hash) VALUES (?, ?)
      `).bind(email, passwordHash).run()
      
      console.log('User created successfully:', email)
    } catch (insertError) {
      console.error('Database error inserting user:', insertError)
      return c.json({ 
        error: 'Failed to create user. Users table may not exist.',
        details: insertError instanceof Error ? insertError.message : 'Unknown database error'
      }, 500)
    }
    
    // Generate session token
    const sessionToken = `${email}:${generateSessionToken()}`
    
    // Set cookie
    setCookie(c, 'session_token', sessionToken, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      maxAge: 60 * 60 * 24 * 30 // 30 days
    })
    
    console.log('Signup: Set session cookie for user:', email)
    return c.json({ success: true, email })
  } catch (error) {
    console.error('Signup error:', error)
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

// API: Login
app.post('/api/login', async (c) => {
  try {
    const formData = await c.req.formData()
    const email = formData.get('email') as string
    const password = formData.get('password') as string
    
    if (!email || !password) {
      return c.json({ error: 'Email and password are required' }, 400)
    }
    
    // Get user
    const user = await c.env.DB.prepare(`
      SELECT id, email, password_hash FROM users WHERE email = ?
    `).bind(email).first() as { id: number; email: string; password_hash: string } | null
    
    if (!user) {
      return c.json({ error: 'Invalid email or password' }, 401)
    }
    
    // Verify password
    const passwordHash = await hashPassword(password)
    if (passwordHash !== user.password_hash) {
      return c.json({ error: 'Invalid email or password' }, 401)
    }
    
    // Generate session token
    const sessionToken = `${user.email}:${generateSessionToken()}`
    
    // Set cookie
    setCookie(c, 'session_token', sessionToken, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      maxAge: 60 * 60 * 24 * 30 // 30 days
    })
    
    console.log('Login: Set session cookie for user:', user.email)
    return c.json({ success: true, email: user.email })
  } catch (error) {
    console.error('Login error:', error)
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

// API: Logout
app.post('/api/logout', (c) => {
  deleteCookie(c, 'session_token')
  return c.json({ success: true })
})

// API: Upload audio and transcribe
app.post('/api/transcribe', async (c) => {
  try {
    const formData = await c.req.formData()
    const audioFile = formData.get('audio') as File
    const language = formData.get('language') as string || 'ja'  // デフォルトは日本語
    const isChunked = formData.get('is_chunked') === 'true'  // チャンク処理フラグ
    const chunkOnly = formData.get('chunk_only') === 'true'  // チャンクのみ処理フラグ
    
    if (!audioFile) {
      return c.json({ error: 'No audio file provided' }, 400)
    }
    
    // チャンクのみ処理（DBに保存せず、文字起こしのみ実行）
    if (chunkOnly) {
      try {
        const arrayBuffer = await audioFile.arrayBuffer()
        const base64Audio = base64Encode(arrayBuffer)
        
        const aiResponse = await c.env.AI.run('@cf/openai/whisper-large-v3-turbo', {
          audio: base64Audio  // Base64エンコードされた文字列として渡す
        }) as any
        
        return c.json({
          status: 'completed',
          transcript: aiResponse.text || '',
          segments: aiResponse.segments || []
        })
      } catch (aiError) {
        const errorMessage = aiError instanceof Error ? aiError.message : 'Unknown error'
        return c.json({
          status: 'failed',
          error: errorMessage
        }, 500)
      }
    }

    // Generate unique key for R2
    const timestamp = Date.now()
    const randomStr = Math.random().toString(36).substring(7)
    const fileKey = `audio/${timestamp}-${randomStr}-${audioFile.name}`

    // Upload to R2
    const arrayBuffer = await audioFile.arrayBuffer()
    await c.env.AUDIO_BUCKET.put(fileKey, arrayBuffer, {
      httpMetadata: {
        contentType: audioFile.type
      }
    })

    // Get user ID from context
    const userId = c.get('userId')
    
    // Insert record into D1
    const initialStatus = isChunked ? 'processing' : 'processing'
    const result = await c.env.DB.prepare(`
      INSERT INTO transcriptions (audio_file_key, audio_file_name, audio_file_size, status, user_id)
      VALUES (?, ?, ?, ?, ?)
    `).bind(fileKey, audioFile.name, audioFile.size, initialStatus, userId).run()

    const transcriptionId = result.meta.last_row_id

    // チャンク処理の場合は、ここでは文字起こしせず、IDだけ返す
    if (isChunked) {
      return c.json({
        id: transcriptionId,
        status: 'processing',
        message: 'Audio file uploaded. Processing chunks...'
      })
    }

    // 通常の処理（小さなファイル）: 文字起こしを実行
    try {
      const audioData = new Uint8Array(arrayBuffer)
      
      // 音声ファイルのサイズをチェック（1MB = 1,048,576バイト）
      // 注意: MP3などのフォーマットはバイナリ分割できないため、チャンク処理を無効化
      const CHUNK_SIZE = 10 * 1024 * 1024 // 10MB（実質的にチャンク処理を無効化）
      const OVERLAP_SIZE = 128 * 1024 // 128KB オーバーラップ（約5-10秒相当）
      const needsChunking = audioData.length > CHUNK_SIZE
      
      let transcriptText = ''
      
      if (needsChunking) {
        // 大きなファイル: オーバーラップを含めてチャンクに分割
        const chunks: Uint8Array[] = []
        for (let i = 0; i < audioData.length; i += CHUNK_SIZE) {
          // オーバーラップを考慮（最初のチャンク以外）
          const start = i > 0 ? Math.max(0, i - OVERLAP_SIZE) : 0
          const end = Math.min(audioData.length, i + CHUNK_SIZE)
          const chunk = audioData.slice(start, end)
          chunks.push(chunk)
          
          // 最後のチャンクに到達したら終了
          if (end >= audioData.length) break
        }
        
        // 各チャンクを順次処理
        const transcripts: string[] = []
        let previousText = ''
        
        for (let i = 0; i < chunks.length; i++) {
          try {
            console.log(`Processing chunk ${i + 1}/${chunks.length}, size: ${chunks[i].length}, language: ${language}`)
            
            const base64Chunk = base64Encode(chunks[i].buffer)
            const chunkResponse = await c.env.AI.run('@cf/openai/whisper-large-v3-turbo', {
              audio: base64Chunk  // Base64エンコードされた文字列として渡す
              // 言語パラメータを削除して自動検出に任せる
            })
            
            if (chunkResponse.text) {
              let currentText = chunkResponse.text.trim()
              
              // オーバーラップ部分の重複を削減（簡易的な処理）
              if (i > 0 && previousText) {
                // 前のチャンクの最後の数単語と現在のチャンクの最初の数単語が一致する場合は削除
                const prevWords = previousText.split(/\s+/).slice(-10) // 最後の10単語
                const currWords = currentText.split(/\s+/)
                
                // 重複する単語数を検出
                let overlapCount = 0
                for (let j = 0; j < Math.min(prevWords.length, currWords.length); j++) {
                  if (prevWords[prevWords.length - 1 - j] === currWords[j]) {
                    overlapCount++
                  } else {
                    break
                  }
                }
                
                // 重複部分を削除
                if (overlapCount > 2) { // 3単語以上重複している場合
                  currentText = currWords.slice(overlapCount).join(' ')
                }
              }
              
              transcripts.push(currentText)
              previousText = currentText
            }
            
            // 進捗を更新
            const progress = Math.round(((i + 1) / chunks.length) * 100)
            await c.env.DB.prepare(`
              UPDATE transcriptions 
              SET error_message = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).bind(`処理中: ${progress}% (${i + 1}/${chunks.length}チャンク)`, transcriptionId).run()
            
          } catch (chunkError) {
            console.error(`Chunk ${i + 1}/${chunks.length} error:`, chunkError)
            transcripts.push(`[チャンク ${i + 1} エラー]`)
          }
        }
        
        transcriptText = transcripts.join(' ')
        
      } else {
        // 小さなファイル: 一度に処理
        console.log(`Processing single file, size: ${audioData.length}, language: ${language}`)
        
        const base64Audio = base64Encode(arrayBuffer)
        const aiResponse = await c.env.AI.run('@cf/openai/whisper-large-v3-turbo', {
          audio: base64Audio  // Base64エンコードされた文字列として渡す
          // 言語パラメータを削除して自動検出に任せる
        }) as any
        transcriptText = aiResponse.text || ''
        
        // デバッグ: セグメント情報をログ出力
        console.log('AI Response:', JSON.stringify(aiResponse, null, 2))
        console.log('Segments count:', aiResponse.segments?.length || 0)
        
        // VTTを生成
        let vttText = ''
        if (aiResponse.segments && aiResponse.segments.length > 0) {
          vttText = generateVTT(aiResponse.segments)
          console.log('VTT generated, length:', vttText.length)
        } else {
          console.log('No segments found in AI response')
        }
        
        // Update with transcription result and VTT
        try {
          await c.env.DB.prepare(`
            UPDATE transcriptions 
            SET transcript_text = ?, vtt_text = ?, status = 'completed', error_message = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(transcriptText, vttText, transcriptionId).run()
          console.log('Database updated with VTT')
        } catch (dbError) {
          console.error('Database update error:', dbError)
          // VTTカラムがない場合は、VTTなしで更新
          await c.env.DB.prepare(`
            UPDATE transcriptions 
            SET transcript_text = ?, status = 'completed', error_message = NULL, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(transcriptText, transcriptionId).run()
          console.log('Database updated without VTT (column may not exist)')
        }
        
        // Generate summary
        console.log('Generating summary...')
        const summary = await generateSummary(transcriptText, c.env.AI)
        console.log('Summary generated, length:', summary.length)
        
        // Update with summary
        try {
          await c.env.DB.prepare(`
            UPDATE transcriptions 
            SET summary_text = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `).bind(summary, transcriptionId).run()
          console.log('Database updated with summary')
        } catch (summaryError) {
          console.error('Summary update error:', summaryError)
          // If summary column doesn't exist, continue without error
        }
        
        return c.json({
          id: transcriptionId,
          status: 'completed',
          transcript: transcriptText,
          vtt: vttText,
          summary: summary
        })
      }

      // Update with transcription result (チャンク処理の場合はVTTなし)
      try {
        await c.env.DB.prepare(`
          UPDATE transcriptions 
          SET transcript_text = ?, vtt_text = NULL, status = 'completed', error_message = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(transcriptText, transcriptionId).run()
      } catch (dbError) {
        console.error('Database update error (chunked):', dbError)
        // VTTカラムがない場合
        await c.env.DB.prepare(`
          UPDATE transcriptions 
          SET transcript_text = ?, status = 'completed', error_message = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(transcriptText, transcriptionId).run()
      }
      
      // Generate summary
      console.log('Generating summary for chunked transcription...')
      const summary = await generateSummary(transcriptText, c.env.AI)
      console.log('Summary generated, length:', summary.length)
      
      // Update with summary
      try {
        await c.env.DB.prepare(`
          UPDATE transcriptions 
          SET summary_text = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(summary, transcriptionId).run()
        console.log('Database updated with summary')
      } catch (summaryError) {
        console.error('Summary update error:', summaryError)
        // If summary column doesn't exist, continue without error
      }

      return c.json({
        id: transcriptionId,
        status: 'completed',
        transcript: transcriptText,
        summary: summary
      })
    } catch (aiError) {
      // Update with error status
      const errorMessage = aiError instanceof Error ? aiError.message : 'Unknown error'
      await c.env.DB.prepare(`
        UPDATE transcriptions 
        SET status = 'failed', error_message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(errorMessage, transcriptionId).run()

      return c.json({
        id: transcriptionId,
        status: 'failed',
        error: errorMessage
      }, 500)
    }
  } catch (error) {
    console.error('Transcription error:', error)
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

// API: Get all transcriptions
app.get('/api/transcriptions', async (c) => {
  try {
    const userId = c.get('userId')
    
    console.log('Fetching transcriptions for user:', userId)
    
    if (!userId) {
      console.error('userId is not set in context')
      return c.json({ error: 'User not authenticated properly' }, 401)
    }
    
    // Check if user_id column exists by trying to select it
    let result
    try {
      result = await c.env.DB.prepare(`
        SELECT id, audio_file_key, audio_file_name, audio_file_size, transcript_text, vtt_text, summary_text, status, error_message, created_at, updated_at
        FROM transcriptions
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT 50
      `).bind(userId).all()
    } catch (dbError) {
      // If user_id column doesn't exist, return empty array
      console.error('Database query failed, user_id column might not exist:', dbError)
      return c.json({ 
        transcriptions: [],
        warning: 'Database migration may not have been applied. Please run migrations.'
      })
    }

    console.log('Transcriptions fetched:', result.results?.length || 0)
    return c.json({ transcriptions: result.results || [] })
  } catch (error) {
    console.error('Get transcriptions error:', error)
    console.error('Error details:', error instanceof Error ? error.stack : error)
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error',
      details: error instanceof Error ? error.stack : String(error)
    }, 500)
  }
})

// API: Get single transcription
app.get('/api/transcriptions/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const userId = c.get('userId')
    
    const result = await c.env.DB.prepare(`
      SELECT id, audio_file_key, audio_file_name, audio_file_size, transcript_text, vtt_text, summary_text, status, error_message, created_at, updated_at
      FROM transcriptions
      WHERE id = ? AND user_id = ?
    `).bind(id, userId).first()

    if (!result) {
      return c.json({ error: 'Transcription not found' }, 404)
    }

    return c.json(result)
  } catch (error) {
    console.error('Get transcription error:', error)
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

// API: Stream audio file from R2
app.get('/api/audio/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const userId = c.get('userId')
    
    // Get audio file key from database (with user check)
    const transcription = await c.env.DB.prepare(`
      SELECT audio_file_key FROM transcriptions WHERE id = ? AND user_id = ?
    `).bind(id, userId).first() as { audio_file_key: string } | null
    
    if (!transcription) {
      return c.json({ error: 'Transcription not found' }, 404)
    }
    
    // Get audio file from R2
    const object = await c.env.AUDIO_BUCKET.get(transcription.audio_file_key)
    
    if (!object) {
      return c.json({ error: 'Audio file not found' }, 404)
    }
    
    // Stream the audio file
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
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

// API: Update transcription with final transcript
app.post('/api/transcriptions/:id/update', async (c) => {
  try {
    const id = c.req.param('id')
    const userId = c.get('userId')
    const formData = await c.req.formData()
    const transcript = formData.get('transcript') as string
    const segmentsJson = formData.get('segments') as string
    
    if (!transcript) {
      return c.json({ error: 'No transcript provided' }, 400)
    }
    
    // VTTを生成（セグメント情報がある場合）
    let vttText = ''
    if (segmentsJson) {
      try {
        const segments = JSON.parse(segmentsJson)
        if (segments && segments.length > 0) {
          vttText = generateVTT(segments)
          console.log('VTT generated from chunked segments, count:', segments.length)
        }
      } catch (parseError) {
        console.error('Failed to parse segments:', parseError)
      }
    }
    
    // Update the transcription record (with user check)
    try {
      await c.env.DB.prepare(`
        UPDATE transcriptions 
        SET transcript_text = ?, vtt_text = ?, status = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).bind(transcript, vttText, id, userId).run()
      console.log('Database updated with chunked VTT')
    } catch (dbError) {
      console.error('Database update error:', dbError)
      // VTTカラムがない場合
      await c.env.DB.prepare(`
        UPDATE transcriptions 
        SET transcript_text = ?, status = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?
      `).bind(transcript, id, userId).run()
    }
    
    return c.json({ success: true })
  } catch (error) {
    console.error('Update transcription error:', error)
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

// API: Update VTT text only
app.post('/api/transcriptions/:id/vtt', async (c) => {
  try {
    const id = c.req.param('id')
    const userId = c.get('userId')
    const formData = await c.req.formData()
    const vttText = formData.get('vtt_text') as string
    
    if (!vttText) {
      return c.json({ error: 'No VTT text provided' }, 400)
    }
    
    // Update only the VTT text (with user check)
    await c.env.DB.prepare(`
      UPDATE transcriptions 
      SET vtt_text = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND user_id = ?
    `).bind(vttText, id, userId).run()
    
    return c.json({ success: true })
  } catch (error) {
    console.error('Update VTT error:', error)
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

// API: Delete transcription
app.delete('/api/transcriptions/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const userId = c.get('userId')
    
    // Get audio file key before deleting (with user check)
    const transcription = await c.env.DB.prepare(`
      SELECT audio_file_key FROM transcriptions WHERE id = ? AND user_id = ?
    `).bind(id, userId).first() as { audio_file_key: string } | null

    if (transcription) {
      // Delete from R2
      await c.env.AUDIO_BUCKET.delete(transcription.audio_file_key)
    }

    // Delete from D1 (with user check)
    await c.env.DB.prepare(`
      DELETE FROM transcriptions WHERE id = ? AND user_id = ?
    `).bind(id, userId).run()

    return c.json({ success: true })
  } catch (error) {
    console.error('Delete transcription error:', error)
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

export default app
