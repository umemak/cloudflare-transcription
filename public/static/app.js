// ============================================================
// Audio Transcription App - Frontend
// Server-side processing via Cloudflare Containers (FFmpeg)
// ============================================================

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
  const fileSizeMB = file.size / (1024 * 1024)

  if (statusDiv) {
    statusDiv.innerHTML = `<p class="info">アップロード中... (${formatBytes(file.size)})</p>`
  }

  try {
    const formData = new FormData()
    formData.append('audio', file)
    formData.append('language', language)

    const response = await fetch('/api/transcribe', {
      method: 'POST',
      body: formData
    })

    const data = await response.json()

    if (!response.ok) {
      throw new Error(data.error || 'アップロードに失敗しました')
    }

    const transcriptionId = data.id

    if (statusDiv) {
      statusDiv.innerHTML = `
        <div class="processing-status">
          <div class="spinner"></div>
          <p class="info" id="processingMessage">サーバーで処理中...</p>
          <p class="meta">FFmpegで音声を分割し、AIで文字起こしを行っています</p>
          <div class="progress-bar-container">
            <div class="progress-bar" id="progressBar" style="width: 5%"></div>
          </div>
        </div>
      `
    }

    // Poll for completion
    await pollTranscriptionStatus(transcriptionId, statusDiv)

    fileInput.value = ''
    loadTranscriptions()

  } catch (error) {
    console.error('Upload error:', error)
    if (statusDiv) statusDiv.innerHTML = `<p class="error">エラー: ${error.message}</p>`
  }
})

// Poll transcription status until complete
async function pollTranscriptionStatus(transcriptionId, statusDiv) {
  const MAX_POLLS = 120  // 10 minutes max (5s interval)
  const POLL_INTERVAL = 5000

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL))

    try {
      const response = await fetch(`/api/transcriptions/${transcriptionId}`)
      if (!response.ok) continue

      const data = await response.json()

      // Update progress UI
      const progressBar = document.getElementById('progressBar')
      const processingMessage = document.getElementById('processingMessage')

      if (data.status === 'completed') {
        // Show results
        let html = `
          <div class="success">
            <p>✅ 文字起こし完了！</p>`

        if (data.summary_text) {
          html += `
            <div class="summary-box" style="background: #e8f5e9; padding: 1rem; margin: 1rem 0; border-radius: 8px; border-left: 4px solid #4caf50;">
              <h3>📝 要約:</h3>
              <p style="white-space: pre-wrap;">${data.summary_text}</p>
            </div>`
        }

        html += `
            <div class="transcript-box">
              <h3>文字起こし結果:</h3>
              <p>${data.transcript_text || '(テキストなし)'}</p>
            </div>
          </div>`

        if (statusDiv) statusDiv.innerHTML = html
        return

      } else if (data.status === 'failed') {
        if (statusDiv) {
          statusDiv.innerHTML = `<p class="error">処理に失敗しました: ${data.error_message || '不明なエラー'}</p>`
        }
        return

      } else if (data.error_message && data.status === 'processing') {
        // Show progress message from container
        if (processingMessage) {
          processingMessage.textContent = data.error_message
        }

        // Estimate progress from message
        const match = data.error_message.match(/(\d+)\/(\d+)/)
        if (match && progressBar) {
          const current = parseInt(match[1])
          const total = parseInt(match[2])
          const percent = Math.round((current / total) * 90) + 5
          progressBar.style.width = `${percent}%`
        } else if (data.error_message.includes('downloading')) {
          if (progressBar) progressBar.style.width = '10%'
        } else if (data.error_message.includes('splitting')) {
          if (progressBar) progressBar.style.width = '20%'
        } else if (data.error_message.includes('summarizing')) {
          if (progressBar) progressBar.style.width = '95%'
        }
      }

    } catch (pollError) {
      console.error('Polling error:', pollError)
    }
  }

  // Timeout
  if (statusDiv) {
    statusDiv.innerHTML = `<p class="error">処理がタイムアウトしました。履歴で状態を確認してください。</p>`
  }
}

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
                ${t.status === 'processing' && t.error_message ? `<br><small>${t.error_message}</small>` : ''}
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
          ${t.summary_text ? `
            <div class="summary-box" style="background: #e8f5e9; padding: 1rem; margin: 1rem 0; border-radius: 8px; border-left: 4px solid #4caf50;">
              <h4>📝 要約:</h4>
              <p style="white-space: pre-wrap;">${t.summary_text}</p>
            </div>
          ` : ''}
          ${t.vtt_text ? `
            <div class="audio-player-container">
              <h4>音声プレーヤー:</h4>
              <audio id="audio-${t.id}" class="audio-player" controls preload="metadata">
                <source src="/api/audio/${t.id}" type="audio/mpeg">
                お使いのブラウザは音声再生に対応していません。
              </audio>
            </div>
            <div class="vtt-editor">
              <h4>VTT編集: <span class="vtt-hint">（タイムスタンプをクリックすると該当箇所を再生）</span></h4>
              <textarea id="vtt-${t.id}" class="vtt-textarea" data-audio-id="audio-${t.id}">${t.vtt_text}</textarea>
            </div>
          ` : ''}
          ${t.error_message && t.status === 'failed' ? `
            <div class="error-message">
              <h4>エラー:</h4>
              <p>${t.error_message}</p>
            </div>
          ` : ''}
        </div>
      `).join('')

      attachTimestampListeners()
    } else {
      listDiv.innerHTML = '<p class="error">データの読み込みに失敗しました</p>'
    }
  } catch (error) {
    console.error('Load error:', error)
    listDiv.innerHTML = '<p class="error">データの読み込みに失敗しました</p>'
  }
}

// Parse VTT timestamp to seconds
function parseVTTTimestamp(timestamp) {
  const parts = timestamp.split(':')
  let hours = 0, minutes = 0, seconds = 0

  if (parts.length === 3) {
    hours = parseInt(parts[0])
    minutes = parseInt(parts[1])
    seconds = parseFloat(parts[2])
  } else if (parts.length === 2) {
    minutes = parseInt(parts[0])
    seconds = parseFloat(parts[1])
  } else {
    seconds = parseFloat(parts[0])
  }

  return hours * 3600 + minutes * 60 + seconds
}

// Attach click listeners to timestamps in VTT textareas
function attachTimestampListeners() {
  document.querySelectorAll('.vtt-textarea').forEach(textarea => {
    const audioId = textarea.getAttribute('data-audio-id')
    if (!audioId) return

    const audio = document.getElementById(audioId)
    if (!audio) return

    textarea.addEventListener('click', function(e) {
      const cursorPos = textarea.selectionStart
      const text = textarea.value
      const lines = text.substring(0, cursorPos).split('\n')
      const currentLine = lines[lines.length - 1]

      const timestampRegex = /(\d{1,2}:)?(\d{1,2}):(\d{1,2}\.\d{3})\s*-->\s*(\d{1,2}:)?(\d{1,2}):(\d{1,2}\.\d{3})/
      const match = currentLine.match(timestampRegex)

      if (match) {
        const startTimestamp = match[0].split('-->')[0].trim()
        const seconds = parseVTTTimestamp(startTimestamp)
        audio.currentTime = seconds
        audio.play().catch(err => console.error('Failed to play:', err))
      }
    })
  })
}

// Download VTT file
async function downloadVTT(id, filename) {
  const textarea = document.getElementById(`vtt-${id}`)
  const vttContent = textarea ? textarea.value : null
  if (vttContent) {
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
}

// Save VTT file
async function saveVTT(id) {
  const textarea = document.getElementById(`vtt-${id}`)
  if (!textarea) { alert('VTTデータが見つかりません'); return }

  const formData = new FormData()
  formData.append('vtt_text', textarea.value)

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
}

// Delete transcription
async function deleteTranscription(id) {
  if (!confirm('この文字起こしを削除しますか？')) return

  const response = await fetch(`/api/transcriptions/${id}`, { method: 'DELETE' })
  if (response.ok) {
    loadTranscriptions()
  } else {
    alert('削除に失敗しました')
  }
}

// Make functions globally accessible
window.downloadVTT = downloadVTT
window.saveVTT = saveVTT
window.deleteTranscription = deleteTranscription

// Refresh button
document.getElementById('refreshBtn')?.addEventListener('click', loadTranscriptions)

// Utility functions
function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i]
}

function formatDate(dateString) {
  return new Date(dateString).toLocaleString('ja-JP')
}

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
