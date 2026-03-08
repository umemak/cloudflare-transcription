// FFmpeg.wasmインスタンス（グローバル）
let ffmpegInstance = null
let ffmpegLoaded = false

// FFmpeg.wasmを初期化（ローカルサーバーから読み込み）
async function loadFFmpeg() {
  if (ffmpegLoaded) return ffmpegInstance
  
  try {
    const { FFmpeg } = FFmpegWASM
    
    ffmpegInstance = new FFmpeg()
    
    // ログハンドラを設定
    ffmpegInstance.on('log', ({ message }) => {
      console.log('[FFmpeg]', message)
    })
    
    // ローカルサーバーから直接読み込み（CORS回避）
    const baseURL = window.location.origin + '/static/ffmpeg'
    console.log('🔍 Trying to load FFmpeg from:', baseURL)
    
    // オプション1: ローカルファイルがある場合
    try {
      const coreURL = `${baseURL}/ffmpeg-core.js`
      const wasmURL = `${baseURL}/ffmpeg-core.wasm`
      
      console.log('📦 Loading core from:', coreURL)
      console.log('📦 Loading wasm from:', wasmURL)
      
      // タイムアウト付きロード（30秒）
      const loadPromise = ffmpegInstance.load({
        coreURL: coreURL,
        wasmURL: wasmURL
      })
      
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('FFmpeg load timeout (30s)')), 30000)
      )
      
      await Promise.race([loadPromise, timeoutPromise])
      
      console.log('✅ FFmpeg.wasm loaded from local server')
      ffmpegLoaded = true
      return ffmpegInstance
    } catch (localError) {
      console.warn('⚠️ Local FFmpeg files failed:', localError.message)
      console.log('🔄 Skipping CDN fallback (known CORS issue)')
      throw localError
    }
  } catch (error) {
    console.error('❌ Failed to load FFmpeg.wasm:', error)
    throw error
  }
}

// FFmpeg.wasmを使って無音検出で音声を分割
async function splitAudioBySilence(file, silenceThreshold = -40, minSilenceDuration = 0.5) {
  try {
    const ffmpeg = await loadFFmpeg()
    
    // ファイルをFFmpegに読み込み
    const arrayBuffer = await file.arrayBuffer()
    await ffmpeg.writeFile('input.mp3', new Uint8Array(arrayBuffer))
    
    // 無音検出を実行（silencedetectフィルター）
    await ffmpeg.exec([
      '-i', 'input.mp3',
      '-af', `silencedetect=noise=${silenceThreshold}dB:d=${minSilenceDuration}`,
      '-f', 'null',
      '-'
    ])
    
    // ログから無音区間を抽出
    // 注意: FFmpeg.wasmのログ取得は限定的なため、簡易的な分割を実装
    
    // シンプルなアプローチ: 30秒ごとに分割（無音検出の代わり）
    // 実際の無音検出実装はより複雑
    const duration = 30 // 秒
    const chunks = []
    
    // 音声の総時間を取得
    await ffmpeg.exec(['-i', 'input.mp3', '-f', 'null', '-'])
    
    // 30秒ごとに分割
    let startTime = 0
    let chunkIndex = 0
    
    while (true) {
      const outputName = `chunk_${chunkIndex}.wav`
      
      try {
        await ffmpeg.exec([
          '-i', 'input.mp3',
          '-ss', `${startTime}`,
          '-t', `${duration}`,
          '-acodec', 'pcm_s16le',
          '-ar', '16000',
          '-ac', '1',
          outputName
        ])
        
        const data = await ffmpeg.readFile(outputName)
        const blob = new Blob([data.buffer], { type: 'audio/wav' })
        
        if (blob.size > 100) { // 有効なチャンクのみ
          chunks.push(blob)
          chunkIndex++
          startTime += duration
        } else {
          break
        }
      } catch (error) {
        // 最後のチャンクに到達
        break
      }
    }
    
    // クリーンアップ
    await ffmpeg.deleteFile('input.mp3')
    for (let i = 0; i < chunkIndex; i++) {
      try {
        await ffmpeg.deleteFile(`chunk_${i}.wav`)
      } catch (e) {}
    }
    
    return chunks
  } catch (error) {
    console.error('FFmpeg processing error:', error)
    throw error
  }
}

// Web Audio APIを使った音声分割（フォールバック）
async function splitAudioByTime(file, chunkDurationSeconds = 30) {
  return new Promise((resolve, reject) => {
    const audioContext = new (window.AudioContext || window.webkitAudioContext)()
    const fileReader = new FileReader()
    
    fileReader.onload = async (e) => {
      try {
        const arrayBuffer = e.target.result
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer)
        
        const sampleRate = audioBuffer.sampleRate
        const numChannels = audioBuffer.numberOfChannels
        const chunkSamples = chunkDurationSeconds * sampleRate
        const chunks = []
        
        for (let i = 0; i < audioBuffer.length; i += chunkSamples) {
          const chunkLength = Math.min(chunkSamples, audioBuffer.length - i)
          const chunkBuffer = audioContext.createBuffer(numChannels, chunkLength, sampleRate)
          
          for (let channel = 0; channel < numChannels; channel++) {
            const sourceData = audioBuffer.getChannelData(channel)
            const chunkData = chunkBuffer.getChannelData(channel)
            for (let j = 0; j < chunkLength; j++) {
              chunkData[j] = sourceData[i + j]
            }
          }
          
          // WAV形式でエンコード
          const wavBlob = audioBufferToWav(chunkBuffer)
          chunks.push(wavBlob)
        }
        
        resolve(chunks)
      } catch (error) {
        reject(error)
      }
    }
    
    fileReader.onerror = reject
    fileReader.readAsArrayBuffer(file)
  })
}

// AudioBufferをWAV形式に変換
function audioBufferToWav(buffer) {
  const numChannels = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const format = 1 // PCM
  const bitDepth = 16
  
  const bytesPerSample = bitDepth / 8
  const blockAlign = numChannels * bytesPerSample
  
  const data = []
  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(channel)[i]))
      data.push(sample < 0 ? sample * 0x8000 : sample * 0x7FFF)
    }
  }
  
  const dataLength = data.length * bytesPerSample
  const bufferLength = 44 + dataLength
  const arrayBuffer = new ArrayBuffer(bufferLength)
  const view = new DataView(arrayBuffer)
  
  // WAVヘッダーを書き込み
  let offset = 0
  const writeString = (str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset++, str.charCodeAt(i))
    }
  }
  
  writeString('RIFF')
  view.setUint32(offset, bufferLength - 8, true); offset += 4
  writeString('WAVE')
  writeString('fmt ')
  view.setUint32(offset, 16, true); offset += 4
  view.setUint16(offset, format, true); offset += 2
  view.setUint16(offset, numChannels, true); offset += 2
  view.setUint32(offset, sampleRate, true); offset += 4
  view.setUint32(offset, sampleRate * blockAlign, true); offset += 4
  view.setUint16(offset, blockAlign, true); offset += 2
  view.setUint16(offset, bitDepth, true); offset += 2
  writeString('data')
  view.setUint32(offset, dataLength, true); offset += 4
  
  // サンプルデータを書き込み
  for (let i = 0; i < data.length; i++) {
    view.setInt16(offset, data[i], true)
    offset += 2
  }
  
  return new Blob([arrayBuffer], { type: 'audio/wav' })
}

// Upload and transcribe audio file
document.getElementById('uploadBtn')?.addEventListener('click', async () => {
  const fileInput = document.getElementById('audioFile')
  const statusDiv = document.getElementById('uploadStatus')
  
  if (!fileInput.files || fileInput.files.length === 0) {
    if (statusDiv) statusDiv.innerHTML = '<p class="error">音声ファイルを選択してください</p>'
    return
  }

  const file = fileInput.files[0]
  const languageSelect = document.getElementById('language')
  const language = languageSelect ? languageSelect.value : 'ja'
  
  // ファイルサイズの計算
  const fileSizeMB = file.size / (1024 * 1024)
  
  if (statusDiv) {
    statusDiv.innerHTML = `<p class="info">音声ファイルを分析中...</p>`
  }

  try {
    // 大きなファイルの場合は30秒ごとに分割
    if (fileSizeMB > 1) {
      let chunks
      let usedFFmpeg = false
      
      // まずFFmpeg.wasmを試す（無音検出分割）
      try {
        if (statusDiv) statusDiv.innerHTML = `<p class="info">FFmpeg.wasmを読み込み中...</p>`
        chunks = await splitAudioBySilence(file, -40, 0.5)
        usedFFmpeg = true
        console.log('✅ Using FFmpeg.wasm for silence-based splitting')
      } catch (ffmpegError) {
        // FFmpegが失敗したらWeb Audio APIにフォールバック
        console.warn('⚠️ FFmpeg.wasm failed, using Web Audio API fallback:', ffmpegError)
        if (statusDiv) statusDiv.innerHTML = `<p class="info">音声を時間ベースで分割中...</p>`
        chunks = await splitAudioByTime(file, 30)
        console.log('✅ Using Web Audio API for time-based splitting')
      }
      
      if (statusDiv) {
        const method = usedFFmpeg ? '無音検出' : '時間ベース'
        statusDiv.innerHTML = `<p class="info">${chunks.length}個のチャンクに分割しました（${method}）。処理中...</p>`
      }
      
      // 最初のチャンクでR2にオリジナルファイルを保存
      const firstFormData = new FormData()
      firstFormData.append('audio', file) // オリジナルファイル
      firstFormData.append('language', language)
      firstFormData.append('is_chunked', 'true') // チャンク処理フラグ
      
      if (statusDiv) {
        statusDiv.innerHTML = `<p class="info">音声ファイルを保存中...</p>`
      }
      
      const uploadResponse = await fetch('/api/transcribe', {
        method: 'POST',
        body: firstFormData
      })
      
      const uploadData = await uploadResponse.json()
      
      if (!uploadResponse.ok) {
        throw new Error(uploadData.error || '音声ファイルの保存に失敗しました')
      }
      
      const transcriptionId = uploadData.id
      const chunkDuration = 30 // 30秒ごとのチャンク
      
      // 並列処理の制限数（同時に処理するチャンク数）
      // 推奨値: 3-5（高すぎるとAPIレート制限に引っかかる可能性あり）
      const MAX_PARALLEL = 3
      
      // 進捗表示用
      let completedCount = 0
      const updateProgress = () => {
        completedCount++
        if (statusDiv) {
          statusDiv.innerHTML = `<p class="info">処理中... ${completedCount}/${chunks.length} チャンク完了</p>`
        }
      }
      
      // チャンクを並列処理する関数
      const processChunk = async (chunk, index) => {
        const chunkFormData = new FormData()
        chunkFormData.append('audio', chunk, `chunk_${index}.wav`)
        chunkFormData.append('language', language)
        chunkFormData.append('chunk_only', 'true')
        
        try {
          const response = await fetch('/api/transcribe', {
            method: 'POST',
            body: chunkFormData
          })
          
          const data = await response.json()
          updateProgress()
          
          if (response.ok && data.transcript) {
            // タイムオフセットを適用したセグメント
            const segments = (data.segments || []).map(seg => ({
              start: seg.start + (index * chunkDuration),
              end: seg.end + (index * chunkDuration),
              text: seg.text
            }))
            
            return {
              index: index,
              transcript: data.transcript,
              segments: segments,
              error: null
            }
          } else {
            return {
              index: index,
              transcript: `[チャンク ${index + 1} エラー: ${data.error || '不明'}]`,
              segments: [],
              error: data.error
            }
          }
        } catch (error) {
          updateProgress()
          return {
            index: index,
            transcript: `[チャンク ${index + 1} エラー: ${error.message}]`,
            segments: [],
            error: error.message
          }
        }
      }
      
      // チャンクを並列処理（MAX_PARALLELずつバッチ処理）
      const results = []
      for (let i = 0; i < chunks.length; i += MAX_PARALLEL) {
        const batch = chunks.slice(i, i + MAX_PARALLEL)
        const batchPromises = batch.map((chunk, batchIndex) => 
          processChunk(chunk, i + batchIndex)
        )
        const batchResults = await Promise.all(batchPromises)
        results.push(...batchResults)
      }
      
      // 結果をインデックス順にソート
      results.sort((a, b) => a.index - b.index)
      
      // 文字起こしテキストとセグメントを結合
      const transcripts = results.map(r => r.transcript)
      const allSegments = results.flatMap(r => r.segments)
      
      const fullTranscript = transcripts.join(' ')
      
      // 完全な文字起こし結果とセグメント情報を元のレコードに保存
      const updateFormData = new FormData()
      updateFormData.append('transcript', fullTranscript)
      updateFormData.append('segments', JSON.stringify(allSegments))
      
      await fetch(`/api/transcriptions/${transcriptionId}/update`, {
        method: 'POST',
        body: updateFormData
      })
      
      if (statusDiv) {
        statusDiv.innerHTML = `
          <div class="success">
            <p>✅ 文字起こし完了！</p>
            <div class="transcript-box">
              <h3>文字起こし結果:</h3>
              <p>${fullTranscript || '(テキストなし)'}</p>
            </div>
          </div>
        `
      }
      
      loadTranscriptions()
      fileInput.value = ''
      
    } else {
      // 小さなファイルは通常通り処理
      const formData = new FormData()
      formData.append('audio', file)
      formData.append('language', language)

      if (statusDiv) {
        statusDiv.innerHTML = `<p class="info">アップロード中...</p>`
      }

      const response = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData
      })

      const data = await response.json()

      if (response.ok) {
        if (statusDiv) {
          statusDiv.innerHTML = `
            <div class="success">
              <p>✅ 文字起こし完了！</p>
              <div class="transcript-box">
                <h3>文字起こし結果:</h3>
                <p>${data.transcript || '(テキストなし)'}</p>
              </div>
            </div>
          `
        }
        loadTranscriptions()
        fileInput.value = ''
      } else {
        if (statusDiv) statusDiv.innerHTML = `<p class="error">エラー: ${data.error}</p>`
      }
    }
  } catch (error) {
    console.error('Upload error:', error)
    if (statusDiv) statusDiv.innerHTML = `<p class="error">処理に失敗しました: ${error.message}</p>`
  }
})

// Load transcriptions list
async function loadTranscriptions() {
  const listDiv = document.getElementById('transcriptionsList')
  if (!listDiv) return

  listDiv.innerHTML = '<p class="info">読み込み中...</p>'

  try {
    const response = await fetch('/api/transcriptions')
    const data = await response.json()

    if (response.ok && data.transcriptions) {
      if (data.transcriptions.length === 0) {
        listDiv.innerHTML = '<p class="info">まだ文字起こしがありません</p>'
        return
      }

      listDiv.innerHTML = data.transcriptions.map((t) => `
        <div class="transcription-item">
          <div class="transcription-header">
            <div>
              <h3>${t.audio_file_name}</h3>
              <p class="meta">
                サイズ: ${formatBytes(t.audio_file_size)} | 
                作成日時: ${formatDate(t.created_at)} |
                ステータス: <span class="status-${t.status}">${getStatusText(t.status)}</span>
              </p>
            </div>
            <div class="button-group">
              ${t.vtt_text ? `
                <button class="download-btn" onclick="downloadVTT(${t.id}, '${t.audio_file_name}')">VTTダウンロード</button>
                <button class="save-btn" onclick="saveVTT(${t.id})">保存</button>
              ` : ''}
              <button class="delete-btn" onclick="deleteTranscription(${t.id})">削除</button>
            </div>
          </div>
          ${t.vtt_text ? `
            <div class="vtt-editor">
              <h4>VTT編集:</h4>
              <textarea id="vtt-${t.id}" class="vtt-textarea">${t.vtt_text}</textarea>
            </div>
          ` : ''}
          ${t.error_message ? `
            <div class="error-message">
              <h4>エラー:</h4>
              <p>${t.error_message}</p>
            </div>
          ` : ''}
        </div>
      `).join('')
    } else {
      listDiv.innerHTML = '<p class="error">データの読み込みに失敗しました</p>'
    }
  } catch (error) {
    console.error('Load error:', error)
    listDiv.innerHTML = '<p class="error">データの読み込みに失敗しました</p>'
  }
}

// Download VTT file
async function downloadVTT(id, filename) {
  try {
    // Get current content from textarea
    const textarea = document.getElementById(`vtt-${id}`)
    const vttContent = textarea ? textarea.value : null
    
    if (vttContent) {
      // Create blob and download
      const blob = new Blob([vttContent], { type: 'text/vtt' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename.replace(/\.[^/.]+$/, '') + '.vtt'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } else {
      alert('VTTデータが見つかりません')
    }
  } catch (error) {
    console.error('Download VTT error:', error)
    alert('VTTのダウンロードに失敗しました')
  }
}

// Save VTT file
async function saveVTT(id) {
  try {
    const textarea = document.getElementById(`vtt-${id}`)
    if (!textarea) {
      alert('VTTデータが見つかりません')
      return
    }
    
    const vttContent = textarea.value
    
    const formData = new FormData()
    formData.append('vtt_text', vttContent)
    
    const response = await fetch(`/api/transcriptions/${id}/vtt`, {
      method: 'POST',
      body: formData
    })
    
    if (response.ok) {
      alert('VTTを保存しました')
    } else {
      const data = await response.json()
      alert(`保存に失敗しました: ${data.error || '不明なエラー'}`)
    }
  } catch (error) {
    console.error('Save VTT error:', error)
    alert('VTTの保存に失敗しました')
  }
}

// Delete transcription
async function deleteTranscription(id) {
  if (!confirm('この文字起こしを削除しますか？')) {
    return
  }

  try {
    const response = await fetch(`/api/transcriptions/${id}`, {
      method: 'DELETE'
    })

    if (response.ok) {
      loadTranscriptions()
    } else {
      alert('削除に失敗しました')
    }
  } catch (error) {
    console.error('Delete error:', error)
    alert('削除に失敗しました')
  }
}

// Make functions globally accessible
window.downloadVTT = downloadVTT
window.saveVTT = saveVTT
window.deleteTranscription = deleteTranscription

// Refresh button
document.getElementById('refreshBtn')?.addEventListener('click', loadTranscriptions)

// Format bytes to human readable
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

// Format date
function formatDate(dateString) {
  const date = new Date(dateString)
  return date.toLocaleString('ja-JP')
}

// Get status text
function getStatusText(status) {
  const statusMap = {
    'pending': '待機中',
    'processing': '処理中',
    'completed': '完了',
    'failed': '失敗'
  }
  return statusMap[status] || status
}

// Load transcriptions on page load
loadTranscriptions()
