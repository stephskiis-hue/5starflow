/**
 * test-browser-auth.js
 * Diagnostic script — run with: node scripts/test-browser-auth.js
 *
 * Launches Chrome NATIVELY (full network access, bypasses macOS sandbox),
 * then connects Playwright via CDP to intercept Bearer tokens from Jobber.
 *
 * Output tells you:
 *  - Whether Chrome launched and CDP connected
 *  - What URL Jobber lands on after navigation
 *  - Whether Bearer tokens appear in any getjobber.com requests
 */

const { chromium } = require('playwright');
const { exec, execSync } = require('child_process');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT    = 9222;

(async () => {
  console.log('=== Jobber Browser Auth Diagnostic (Native Chrome + CDP) ===\n');

  // Step 1: Kill anything already using the CDP port
  console.log(`Clearing port ${CDP_PORT}...`);
  try {
    execSync(`kill $(lsof -ti tcp:${CDP_PORT}) 2>/dev/null || true`, { shell: true });
    await new Promise(r => setTimeout(r, 500));
  } catch { /* nothing was using it */ }

  // Step 2: Launch Chrome natively — gets full macOS network access (no sandbox)
  console.log('Launching Chrome natively with remote debugging...');
  const chromeProc = exec(
    `"${CHROME_PATH}" --remote-debugging-port=${CDP_PORT} --new-window "https://app.getjobber.com/accounts/login"`,
    (err) => { if (err && !err.killed) console.error('Chrome process error:', err.message); }
  );
  chromeProc.unref(); // don't keep Node alive waiting for Chrome

  // Step 3: Wait for Chrome to start its CDP server
  console.log('Waiting 3s for Chrome to start...');
  await new Promise(r => setTimeout(r, 3000));

  // Step 4: Connect Playwright to the running Chrome via CDP
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
    console.log('✓ Connected to Chrome via CDP\n');
  } catch (err) {
    console.error('✗ Could not connect to Chrome via CDP:', err.message);
    console.error('  Make sure Chrome is installed at:', CHROME_PATH);
    process.exit(1);
  }

  // Step 5: Get (or create) a page in the existing Chrome context
  const context = browser.contexts()[0];
  if (!context) {
    console.error('✗ No browser context found in Chrome');
    process.exit(1);
  }

  const page = context.pages()[0] || await context.newPage();
  console.log('Current URL:', page.url());

  // Step 6: Monitor network requests for Bearer tokens
  const capturedTokens    = [];
  const getjobberRequests = [];

  page.on('request', req => {
    const url  = req.url();
    const auth = req.headers()['authorization'] || '';
    if (url.includes('getjobber.com')) {
      getjobberRequests.push({ url: url.slice(0, 100), hasBearer: auth.startsWith('Bearer ') });
      if (auth.startsWith('Bearer ') && capturedTokens.length < 5) {
        const preview = auth.slice(7, 70) + '...';
        capturedTokens.push(preview);
        console.log('\n✓ BEARER TOKEN found!');
        console.log('  URL:', url.slice(0, 80));
        console.log('  Token preview:', preview);
      }
    }
  });

  page.on('framenavigated', frame => {
    if (frame === page.mainFrame()) {
      console.log('→ URL:', frame.url());
    }
  });

  // Navigate to Jobber if not already there
  if (!page.url().includes('getjobber.com')) {
    console.log('\nNavigating to Jobber login...');
    try {
      await page.goto('https://app.getjobber.com/accounts/login', {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
    } catch (err) {
      console.error('Navigation error:', err.message);
      console.log('Current URL:', page.url());
    }
  }

  // Step 7: Wait for user to log in
  console.log('\n' + '='.repeat(50));
  console.log('LOG IN TO JOBBER NOW — you have 3 minutes');
  console.log('='.repeat(50) + '\n');

  try {
    await page.waitForURL(
      url => !url.includes('/accounts/login') && !url.includes('about:blank'),
      { timeout: 180000 }
    );
    console.log('\nLogin complete! URL:', page.url());

    // Wait for post-login API calls
    console.log('Waiting 5s for API calls to fire...');
    await page.waitForTimeout(5000);

    // Navigate to invoices to force a GraphQL token if not captured yet
    if (capturedTokens.length === 0) {
      console.log('No token yet — navigating to /invoices to trigger API call...');
      try {
        await page.goto('https://app.getjobber.com/invoices', {
          waitUntil: 'networkidle',
          timeout: 15000,
        });
        await page.waitForTimeout(3000);
      } catch { /* timeout ok */ }
    }
  } catch {
    console.log('\nTimed out waiting for login. Current URL:', page.url());
  }

  // Step 8: Report results
  console.log('\n' + '='.repeat(50));
  console.log('RESULTS');
  console.log('='.repeat(50));
  console.log('Bearer tokens captured:', capturedTokens.length);
  if (capturedTokens.length > 0) {
    console.log('Token previews:');
    capturedTokens.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));
    console.log('\n✓ SUCCESS — browser auth should work');
  } else {
    console.log('\n✗ No tokens captured');
    console.log('Total getjobber.com requests seen:', getjobberRequests.length);
    if (getjobberRequests.length > 0) {
      console.log('Sample requests (no Bearer):');
      getjobberRequests.slice(0, 5).forEach(r => console.log(' ', r.url));
    }
  }

  // Disconnect from CDP — leave Chrome open (user launched it natively)
  await browser.disconnect();
  console.log('\nDisconnected from CDP. Chrome stays open. Done.');
})().catch(err => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
