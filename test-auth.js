import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  
  // Enable console logging
  page.on('console', msg => console.log('BROWSER:', msg.text()));
  page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
  
  try {
    console.log('\n=== Step 1: Navigate to signup page ===');
    await page.goto('https://cloudflare-transcription.umemak.workers.dev/signup');
    await page.waitForLoadState('networkidle');
    
    console.log('\n=== Step 2: Fill signup form ===');
    const testEmail = `test${Date.now()}@example.com`;
    const testPassword = 'testpassword123';
    
    await page.fill('#signupEmail', testEmail);
    await page.fill('#signupPassword', testPassword);
    await page.fill('#signupPasswordConfirm', testPassword);
    
    console.log('Test email:', testEmail);
    
    console.log('\n=== Step 3: Submit signup form ===');
    // Listen for the API response
    const signupPromise = page.waitForResponse(
      response => response.url().includes('/api/signup') && response.request().method() === 'POST'
    );
    
    await page.click('button[type="submit"]');
    const signupResponse = await signupPromise;
    const signupData = await signupResponse.json();
    
    console.log('Signup response status:', signupResponse.status());
    console.log('Signup response data:', JSON.stringify(signupData, null, 2));
    
    // Wait for redirect or error message
    await page.waitForTimeout(2000);
    
    console.log('\n=== Step 4: Check cookies ===');
    const cookies = await context.cookies();
    console.log('Cookies:', JSON.stringify(cookies, null, 2));
    
    const sessionCookie = cookies.find(c => c.name === 'session_token');
    if (sessionCookie) {
      console.log('✅ Session cookie found:', sessionCookie.value.substring(0, 50) + '...');
    } else {
      console.log('❌ Session cookie NOT found!');
    }
    
    console.log('\n=== Step 5: Check current URL ===');
    console.log('Current URL:', page.url());
    
    console.log('\n=== Step 6: Try to access home page ===');
    await page.goto('https://cloudflare-transcription.umemak.workers.dev/');
    await page.waitForLoadState('networkidle');
    console.log('Current URL after home navigation:', page.url());
    
    console.log('\n=== Step 7: Check API call ===');
    // Wait for API call to transcriptions
    const apiPromise = page.waitForResponse(
      response => response.url().includes('/api/transcriptions'),
      { timeout: 5000 }
    ).catch(() => null);
    
    await page.waitForTimeout(2000);
    const apiResponse = await apiPromise;
    
    if (apiResponse) {
      console.log('API response status:', apiResponse.status());
      const apiData = await apiResponse.json().catch(() => null);
      console.log('API response data:', JSON.stringify(apiData, null, 2));
    } else {
      console.log('No API call to /api/transcriptions detected');
    }
    
    console.log('\n=== Step 8: Take screenshot ===');
    await page.screenshot({ path: '/tmp/auth-test.png', fullPage: true });
    console.log('Screenshot saved to /tmp/auth-test.png');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error(error.stack);
  } finally {
    await browser.close();
  }
})();
