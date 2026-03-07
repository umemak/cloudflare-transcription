import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { renderer } from './renderer'

type Bindings = {
  DB: D1Database
  AUDIO_BUCKET: R2Bucket
  AI: Ai
}

const app = new Hono<{ Bindings: Bindings }>()

// Enable CORS for API routes
app.use('/api/*', cors())

// Frontend renderer
app.use(renderer)

// Home page
app.get('/', (c) => {
  return c.render(
    <>
      <div className="container">
        <h1>🎙️ 音声文字起こしアプリ</h1>
        <p>音声ファイルをアップロードして、AIで自動文字起こしを行います</p>
        
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

      <script src="/static/app.js"></script>
    </>
  )
})

// API: Upload audio and transcribe
app.post('/api/transcribe', async (c) => {
  try {
    const formData = await c.req.formData()
    const audioFile = formData.get('audio') as File
    const language = formData.get('language') as string || 'ja'  // デフォルトは日本語
    
    if (!audioFile) {
      return c.json({ error: 'No audio file provided' }, 400)
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

    // Insert record into D1
    const result = await c.env.DB.prepare(`
      INSERT INTO transcriptions (audio_file_key, audio_file_name, audio_file_size, status)
      VALUES (?, ?, ?, 'processing')
    `).bind(fileKey, audioFile.name, audioFile.size).run()

    const transcriptionId = result.meta.last_row_id

    // Perform transcription using Cloudflare AI
    try {
      const audioData = new Uint8Array(arrayBuffer)
      
      // 音声ファイルのサイズをチェック（1MB = 1,048,576バイト）
      const CHUNK_SIZE = 1 * 1024 * 1024 // 1MB
      const needsChunking = audioData.length > CHUNK_SIZE
      
      let transcriptText = ''
      
      if (needsChunking) {
        // 大きなファイル: チャンクに分割して処理
        const chunks: Uint8Array[] = []
        for (let i = 0; i < audioData.length; i += CHUNK_SIZE) {
          const chunk = audioData.slice(i, i + CHUNK_SIZE)
          chunks.push(chunk)
        }
        
        // 各チャンクを順次処理
        const transcripts: string[] = []
        for (let i = 0; i < chunks.length; i++) {
          try {
            const chunkResponse = await c.env.AI.run('@cf/openai/whisper', {
              audio: [...chunks[i]],
              source_lang: language
            })
            
            if (chunkResponse.text) {
              transcripts.push(chunkResponse.text)
            }
            
            // 進捗を更新（オプション）
            const progress = Math.round(((i + 1) / chunks.length) * 100)
            await c.env.DB.prepare(`
              UPDATE transcriptions 
              SET error_message = ?, updated_at = CURRENT_TIMESTAMP
              WHERE id = ?
            `).bind(`処理中: ${progress}%`, transcriptionId).run()
            
          } catch (chunkError) {
            console.error(`Chunk ${i + 1}/${chunks.length} error:`, chunkError)
            transcripts.push(`[チャンク ${i + 1} エラー]`)
          }
        }
        
        transcriptText = transcripts.join(' ')
        
      } else {
        // 小さなファイル: 一度に処理
        const aiResponse = await c.env.AI.run('@cf/openai/whisper', {
          audio: [...audioData],
          source_lang: language
        })
        transcriptText = aiResponse.text || ''
      }

      // Update with transcription result
      await c.env.DB.prepare(`
        UPDATE transcriptions 
        SET transcript_text = ?, status = 'completed', error_message = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(transcriptText, transcriptionId).run()

      return c.json({
        id: transcriptionId,
        status: 'completed',
        transcript: transcriptText
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
    const result = await c.env.DB.prepare(`
      SELECT id, audio_file_name, audio_file_size, transcript_text, status, error_message, created_at, updated_at
      FROM transcriptions
      ORDER BY created_at DESC
      LIMIT 50
    `).all()

    return c.json({ transcriptions: result.results })
  } catch (error) {
    console.error('Get transcriptions error:', error)
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

// API: Get single transcription
app.get('/api/transcriptions/:id', async (c) => {
  try {
    const id = c.req.param('id')
    const result = await c.env.DB.prepare(`
      SELECT id, audio_file_name, audio_file_size, transcript_text, status, error_message, created_at, updated_at
      FROM transcriptions
      WHERE id = ?
    `).bind(id).first()

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

// API: Delete transcription
app.delete('/api/transcriptions/:id', async (c) => {
  try {
    const id = c.req.param('id')
    
    // Get audio file key before deleting
    const transcription = await c.env.DB.prepare(`
      SELECT audio_file_key FROM transcriptions WHERE id = ?
    `).bind(id).first() as { audio_file_key: string } | null

    if (transcription) {
      // Delete from R2
      await c.env.AUDIO_BUCKET.delete(transcription.audio_file_key)
    }

    // Delete from D1
    await c.env.DB.prepare(`
      DELETE FROM transcriptions WHERE id = ?
    `).bind(id).run()

    return c.json({ success: true })
  } catch (error) {
    console.error('Delete transcription error:', error)
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})

export default app
