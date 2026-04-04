import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, unlink, mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const execFileAsync = promisify(execFile)

const app = new Hono()

// --- Health check ---
app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

// --- Main transcription job endpoint ---
// Worker から呼ばれる。音声データを受け取り、FFmpeg分割 → Whisper → VTT → 要約 の全処理を行う
app.post('/process', async (c) => {
  const jobId = crypto.randomUUID()
  console.log(`[Job ${jobId}] Received processing request`)

  let workDir
  try {
    const body = await c.req.json()
    const {
      audioUrl,       // R2 presigned URL or Worker proxy URL for audio file
      audioFileName,  // Original file name
      callbackUrl,    // Worker callback URL to report results
      transcriptionId,
      language = 'ja',
    } = body

    if (!audioUrl || !callbackUrl || !transcriptionId) {
      return c.json({ error: 'Missing required fields: audioUrl, callbackUrl, transcriptionId' }, 400)
    }

    // Return 202 immediately - process in background
    // We use waitUntil pattern: start the background work then respond
    const processPromise = processAudio({
      jobId, audioUrl, audioFileName, callbackUrl, transcriptionId, language
    })

    // Don't await - let it run in background
    processPromise.catch(err => {
      console.error(`[Job ${jobId}] Unhandled error in background processing:`, err)
    })

    return c.json({ jobId, status: 'accepted' }, 202)
  } catch (error) {
    console.error(`[Job ${jobId}] Request parse error:`, error)
    return c.json({ error: 'Invalid request body' }, 400)
  }
})

// --- Background processing function ---
async function processAudio({ jobId, audioUrl, audioFileName, callbackUrl, transcriptionId, language }) {
  let workDir
  try {
    // 1. Create temp working directory
    workDir = await mkdtemp(path.join(tmpdir(), 'transcribe-'))
    console.log(`[Job ${jobId}] Working directory: ${workDir}`)

    // 2. Download audio from R2 via Worker proxy
    console.log(`[Job ${jobId}] Downloading audio...`)
    await sendProgress(callbackUrl, transcriptionId, 'downloading', '音声ファイルをダウンロード中...')

    const audioResponse = await fetch(audioUrl)
    if (!audioResponse.ok) {
      throw new Error(`Failed to download audio: ${audioResponse.status} ${audioResponse.statusText}`)
    }
    const audioBuffer = Buffer.from(await audioResponse.arrayBuffer())

    const ext = path.extname(audioFileName || 'audio.mp3') || '.mp3'
    const inputPath = path.join(workDir, `input${ext}`)
    await writeFile(inputPath, audioBuffer)
    console.log(`[Job ${jobId}] Audio saved: ${inputPath} (${audioBuffer.length} bytes)`)

    // 3. Get audio duration via FFmpeg
    const duration = await getAudioDuration(inputPath)
    console.log(`[Job ${jobId}] Audio duration: ${duration}s`)

    // 4. Split audio using FFmpeg silence detection or fixed intervals
    await sendProgress(callbackUrl, transcriptionId, 'splitting', '音声を分割中...')
    const chunkPaths = await splitAudio(inputPath, workDir, duration, jobId)
    console.log(`[Job ${jobId}] Split into ${chunkPaths.length} chunks`)

    // 5. Transcribe each chunk via Whisper (through Worker proxy)
    await sendProgress(callbackUrl, transcriptionId, 'transcribing', `文字起こし中... (0/${chunkPaths.length})`)

    const allSegments = []
    const allTranscripts = []
    let timeOffset = 0

    for (let i = 0; i < chunkPaths.length; i++) {
      console.log(`[Job ${jobId}] Transcribing chunk ${i + 1}/${chunkPaths.length}`)
      await sendProgress(
        callbackUrl, transcriptionId, 'transcribing',
        `文字起こし中... (${i + 1}/${chunkPaths.length})`
      )

      const chunkData = await readFile(chunkPaths[i].path)
      const base64Audio = chunkData.toString('base64')

      // Call Worker's Whisper proxy endpoint
      const whisperUrl = new URL('/api/internal/whisper', callbackUrl).href
      const whisperResponse = await fetch(whisperUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: base64Audio, language })
      })

      if (!whisperResponse.ok) {
        console.error(`[Job ${jobId}] Whisper error for chunk ${i}:`, await whisperResponse.text())
        allTranscripts.push(`[チャンク ${i + 1} エラー]`)
        timeOffset += chunkPaths[i].duration
        continue
      }

      const whisperResult = await whisperResponse.json()
      const text = whisperResult.text || ''
      const segments = (whisperResult.segments || []).map(seg => ({
        start: seg.start + timeOffset,
        end: seg.end + timeOffset,
        text: seg.text
      }))

      allTranscripts.push(text)
      allSegments.push(...segments)
      timeOffset += chunkPaths[i].duration
    }

    const fullTranscript = allTranscripts.join(' ').trim()

    // 6. Generate VTT from segments
    const vttText = generateVTT(allSegments)
    console.log(`[Job ${jobId}] VTT generated: ${vttText.length} chars`)

    // 7. Generate summary via Worker proxy
    await sendProgress(callbackUrl, transcriptionId, 'summarizing', '要約を生成中...')
    let summary = ''
    try {
      const summaryUrl = new URL('/api/internal/summarize', callbackUrl).href
      const summaryResponse = await fetch(summaryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: fullTranscript })
      })
      if (summaryResponse.ok) {
        const summaryResult = await summaryResponse.json()
        summary = summaryResult.summary || ''
      }
    } catch (summaryError) {
      console.error(`[Job ${jobId}] Summary error:`, summaryError)
      summary = '要約の生成に失敗しました。'
    }

    // 8. Send final results to Worker callback
    console.log(`[Job ${jobId}] Sending results...`)
    await sendCallback(callbackUrl, transcriptionId, {
      status: 'completed',
      transcript: fullTranscript,
      vtt: vttText,
      summary,
      chunkCount: chunkPaths.length,
      duration
    })

    console.log(`[Job ${jobId}] Job completed successfully`)

  } catch (error) {
    console.error(`[Job ${jobId}] Processing error:`, error)

    try {
      await sendCallback(callbackUrl, transcriptionId, {
        status: 'failed',
        error: error.message || 'Unknown processing error'
      })
    } catch (callbackError) {
      console.error(`[Job ${jobId}] Callback error:`, callbackError)
    }
  } finally {
    // Cleanup
    if (workDir) {
      try {
        await rm(workDir, { recursive: true, force: true })
        console.log(`[Job ${jobId}] Cleaned up ${workDir}`)
      } catch (e) {
        console.error(`[Job ${jobId}] Cleanup error:`, e)
      }
    }
  }
}

// --- FFmpeg helpers ---

async function getAudioDuration(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'quiet',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath
    ])
    return parseFloat(stdout.trim()) || 0
  } catch (error) {
    console.error('Duration detection failed:', error)
    return 0
  }
}

async function splitAudio(inputPath, workDir, totalDuration, jobId) {
  const CHUNK_DURATION = 30 // seconds
  const chunks = []

  if (totalDuration <= CHUNK_DURATION + 5) {
    // Short audio - convert to WAV without splitting
    const outputPath = path.join(workDir, 'chunk_000.wav')
    await execFileAsync('ffmpeg', [
      '-i', inputPath,
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      '-y', outputPath
    ])
    chunks.push({ path: outputPath, duration: totalDuration })
    return chunks
  }

  // Try silence detection first
  try {
    const silenceChunks = await splitBySilence(inputPath, workDir, totalDuration, jobId)
    if (silenceChunks.length > 0) {
      return silenceChunks
    }
  } catch (error) {
    console.log(`[Job ${jobId}] Silence detection failed, falling back to fixed intervals:`, error.message)
  }

  // Fallback: fixed interval splitting
  const numChunks = Math.ceil(totalDuration / CHUNK_DURATION)
  for (let i = 0; i < numChunks; i++) {
    const startTime = i * CHUNK_DURATION
    const chunkDur = Math.min(CHUNK_DURATION, totalDuration - startTime)
    const outputPath = path.join(workDir, `chunk_${String(i).padStart(3, '0')}.wav`)

    await execFileAsync('ffmpeg', [
      '-i', inputPath,
      '-ss', String(startTime),
      '-t', String(chunkDur),
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      '-y', outputPath
    ])

    chunks.push({ path: outputPath, duration: chunkDur })
  }

  return chunks
}

async function splitBySilence(inputPath, workDir, totalDuration, jobId) {
  // Detect silence boundaries
  const { stderr } = await execFileAsync('ffmpeg', [
    '-i', inputPath,
    '-af', 'silencedetect=noise=-35dB:d=0.5',
    '-f', 'null',
    '-'
  ], { maxBuffer: 10 * 1024 * 1024 })

  // Parse silence_end timestamps from FFmpeg output
  const silenceEnds = []
  const regex = /silence_end: ([\d.]+)/g
  let match
  while ((match = regex.exec(stderr)) !== null) {
    silenceEnds.push(parseFloat(match[1]))
  }

  console.log(`[Job ${jobId}] Found ${silenceEnds.length} silence points`)

  if (silenceEnds.length === 0) {
    return [] // No silence detected, fallback to fixed
  }

  // Group silence points into ~30s chunks
  const CHUNK_TARGET = 30
  const splitPoints = [0]
  let lastSplit = 0

  for (const silEnd of silenceEnds) {
    if (silEnd - lastSplit >= CHUNK_TARGET * 0.8) {
      splitPoints.push(silEnd)
      lastSplit = silEnd
    }
  }
  if (splitPoints[splitPoints.length - 1] < totalDuration - 1) {
    splitPoints.push(totalDuration)
  }

  // Extract chunks at split points
  const chunks = []
  for (let i = 0; i < splitPoints.length - 1; i++) {
    const start = splitPoints[i]
    const dur = splitPoints[i + 1] - start
    if (dur < 0.5) continue

    const outputPath = path.join(workDir, `chunk_${String(i).padStart(3, '0')}.wav`)
    await execFileAsync('ffmpeg', [
      '-i', inputPath,
      '-ss', String(start),
      '-t', String(dur),
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      '-y', outputPath
    ])

    chunks.push({ path: outputPath, duration: dur })
  }

  return chunks
}

// --- VTT generation ---

function formatTimeVTT(seconds) {
  const H = String(Math.floor(seconds / 3600)).padStart(2, '0')
  const M = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
  const S = String(Math.floor(seconds % 60)).padStart(2, '0')
  const ms = String(Math.round((seconds % 1) * 1000)).padStart(3, '0')
  return `${H}:${M}:${S}.${ms}`
}

function generateVTT(segments) {
  let vtt = 'WEBVTT\n\n'
  for (const seg of segments) {
    vtt += `${formatTimeVTT(seg.start)} --> ${formatTimeVTT(seg.end)}\n`
    vtt += `${seg.text}\n\n`
  }
  return vtt
}

// --- Callback helpers ---

async function sendProgress(callbackUrl, transcriptionId, phase, message) {
  try {
    const url = new URL('/api/internal/progress', callbackUrl).href
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcriptionId, phase, message })
    })
  } catch (error) {
    console.error('Progress update failed:', error.message)
  }
}

async function sendCallback(callbackUrl, transcriptionId, result) {
  const url = new URL('/api/internal/callback', callbackUrl).href
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcriptionId, ...result })
  })
  if (!response.ok) {
    throw new Error(`Callback failed: ${response.status} ${response.statusText}`)
  }
}

// --- Start server ---
const port = 8080
console.log(`Transcription container starting on port ${port}`)
serve({ fetch: app.fetch, port })
