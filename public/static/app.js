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
  
  // 警告: 大きなファイルの場合
  const fileSizeMB = file.size / (1024 * 1024)
  if (fileSizeMB > 1) {
    if (!confirm(`ファイルサイズが ${fileSizeMB.toFixed(2)} MB です。大きなファイルや長い音声の文字起こしは失敗する可能性があります。続行しますか？`)) {
      return
    }
  }
  
  const formData = new FormData()
  formData.append('audio', file)
  formData.append('language', language)

  if (statusDiv) statusDiv.innerHTML = '<p class="info">アップロード中...</p>'

  try {
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
      // Refresh the list
      loadTranscriptions()
      // Clear file input
      fileInput.value = ''
    } else {
      if (statusDiv) statusDiv.innerHTML = `<p class="error">エラー: ${data.error}</p>`
    }
  } catch (error) {
    console.error('Upload error:', error)
    if (statusDiv) statusDiv.innerHTML = `<p class="error">アップロードに失敗しました</p>`
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
            <button class="delete-btn" onclick="deleteTranscription(${t.id})">削除</button>
          </div>
          ${t.transcript_text ? `
            <div class="transcript-text">
              <h4>文字起こし結果:</h4>
              <p>${t.transcript_text}</p>
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

// Make deleteTranscription globally accessible
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
