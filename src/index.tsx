import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { renderer } from './renderer'

type Bindings = {
  DB: D1Database
  AUDIO_BUCKET: R2Bucket
  AI: Ai
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

    // Insert record into D1
    const initialStatus = isChunked ? 'processing' : 'processing'
    const result = await c.env.DB.prepare(`
      INSERT INTO transcriptions (audio_file_key, audio_file_name, audio_file_size, status)
      VALUES (?, ?, ?, ?)
    `).bind(fileKey, audioFile.name, audioFile.size, initialStatus).run()

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
        
        return c.json({
          id: transcriptionId,
          status: 'completed',
          transcript: transcriptText,
          vtt: vttText
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
      SELECT id, audio_file_name, audio_file_size, transcript_text, vtt_text, status, error_message, created_at, updated_at
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
      SELECT id, audio_file_name, audio_file_size, transcript_text, vtt_text, status, error_message, created_at, updated_at
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

// API: Update transcription with final transcript
app.post('/api/transcriptions/:id/update', async (c) => {
  try {
    const id = c.req.param('id')
    const formData = await c.req.formData()
    const transcript = formData.get('transcript') as string
    
    if (!transcript) {
      return c.json({ error: 'No transcript provided' }, 400)
    }
    
    // Update the transcription record
    await c.env.DB.prepare(`
      UPDATE transcriptions 
      SET transcript_text = ?, status = 'completed', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(transcript, id).run()
    
    return c.json({ success: true })
  } catch (error) {
    console.error('Update transcription error:', error)
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
