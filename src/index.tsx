import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { renderer } from './renderer'

type Bindings = {
  DB: D1Database
  AUDIO_BUCKET?: R2Bucket
  AI?: Ai
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
    // Check if required services are available
    if (!c.env.AUDIO_BUCKET) {
      return c.json({ 
        error: 'R2 storage is not configured. Please set up Cloudflare API key.' 
      }, 503)
    }
    
    if (!c.env.AI) {
      return c.json({ 
        error: 'AI service is not configured. Please set up Cloudflare API key.' 
      }, 503)
    }

    const formData = await c.req.formData()
    const audioFile = formData.get('audio') as File
    
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
      // Convert ArrayBuffer to Uint8Array for AI API
      const audioData = new Uint8Array(arrayBuffer)
      
      const aiResponse = await c.env.AI.run('@cf/openai/whisper', {
        audio: Array.from(audioData)
      })

      const transcriptText = aiResponse.text || ''

      // Update with transcription result
      await c.env.DB.prepare(`
        UPDATE transcriptions 
        SET transcript_text = ?, status = 'completed', updated_at = CURRENT_TIMESTAMP
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

    if (transcription && c.env.AUDIO_BUCKET) {
      // Delete from R2 if available
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
