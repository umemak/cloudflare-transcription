// Login form handler
document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  
  const email = document.getElementById('loginEmail').value
  const password = document.getElementById('loginPassword').value
  const statusDiv = document.getElementById('loginStatus')
  
  if (statusDiv) {
    statusDiv.innerHTML = '<p class="info">ログイン中...</p>'
  }
  
  try {
    const formData = new FormData()
    formData.append('email', email)
    formData.append('password', password)
    
    const response = await fetch('/api/login', {
      method: 'POST',
      body: formData
    })
    
    const data = await response.json()
    
    if (response.ok) {
      if (statusDiv) {
        statusDiv.innerHTML = '<p class="success">ログイン成功！リダイレクト中...</p>'
      }
      // Redirect to home page
      setTimeout(() => {
        window.location.href = '/'
      }, 1000)
    } else {
      if (statusDiv) {
        statusDiv.innerHTML = `<p class="error">エラー: ${data.error}</p>`
      }
    }
  } catch (error) {
    console.error('Login error:', error)
    if (statusDiv) {
      statusDiv.innerHTML = '<p class="error">ログインに失敗しました</p>'
    }
  }
})

// Signup form handler
document.getElementById('signupForm')?.addEventListener('submit', async (e) => {
  e.preventDefault()
  
  const email = document.getElementById('signupEmail').value
  const password = document.getElementById('signupPassword').value
  const passwordConfirm = document.getElementById('signupPasswordConfirm').value
  const statusDiv = document.getElementById('signupStatus')
  
  // Validate password match
  if (password !== passwordConfirm) {
    if (statusDiv) {
      statusDiv.innerHTML = '<p class="error">パスワードが一致しません</p>'
    }
    return
  }
  
  if (password.length < 8) {
    if (statusDiv) {
      statusDiv.innerHTML = '<p class="error">パスワードは8文字以上である必要があります</p>'
    }
    return
  }
  
  if (statusDiv) {
    statusDiv.innerHTML = '<p class="info">登録中...</p>'
  }
  
  try {
    const formData = new FormData()
    formData.append('email', email)
    formData.append('password', password)
    
    const response = await fetch('/api/signup', {
      method: 'POST',
      body: formData
    })
    
    const data = await response.json()
    
    if (response.ok) {
      if (statusDiv) {
        statusDiv.innerHTML = '<p class="success">登録成功！リダイレクト中...</p>'
      }
      // Redirect to home page
      setTimeout(() => {
        window.location.href = '/'
      }, 1000)
    } else {
      if (statusDiv) {
        statusDiv.innerHTML = `<p class="error">エラー: ${data.error}</p>`
      }
    }
  } catch (error) {
    console.error('Signup error:', error)
    if (statusDiv) {
      statusDiv.innerHTML = '<p class="error">登録に失敗しました</p>'
    }
  }
})

// Logout button handler
document.getElementById('logoutBtn')?.addEventListener('click', async () => {
  try {
    const response = await fetch('/api/logout', {
      method: 'POST'
    })
    
    if (response.ok) {
      window.location.href = '/login'
    } else {
      alert('ログアウトに失敗しました')
    }
  } catch (error) {
    console.error('Logout error:', error)
    alert('ログアウトに失敗しました')
  }
})
