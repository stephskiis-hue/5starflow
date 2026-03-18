/**
 * browserAuth.js
 * Zapier-style Jobber login: launches Chrome NATIVELY (full network access),
 * then connects Playwright via CDP to capture the Bearer token from Jobber's
 * own API requests after the user logs in.
 *
 * Why native launch instead of chromium.launch():
 *   Playwright-spawned Chrome inherits Node's macOS network sandbox and gets
 *   no DNS/internet access. Launching Chrome as a standalone OS process via
 *   exec() gives it full network access. Playwright then connects to it via
 *   Chrome DevTools Protocol (CDP) at localhost:9222.
 */

const { chromium } = require('playwright');
const { exec, execSync } = require('child_process');
const prisma = require('../lib/prismaClient');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CDP_PORT    = 9222;

/**
 * Launch visible Chrome natively, wait for the user to log into Jobber,
 * and capture the Bearer token from network requests.
 *
 * @param {number} timeoutMs  Max time for user to complete login (default: 5 min)
 * @returns {Promise<string>} The captured Bearer token
 */
async function captureBrowserToken(timeoutMs = 300000) {
  console.log('[browserAuth] Starting native Chrome launch with remote debugging...');

  // Step 1: Clear any existing process on the CDP port
  try {
    execSync(`kill $(lsof -ti tcp:${CDP_PORT}) 2>/dev/null || true`, { shell: true });
    await new Promise(r => setTimeout(r, 500));
  } catch { /* nothing was using the port */ }

  // Step 2: Launch Chrome natively — full macOS network access (not sandboxed)
  const chromeProc = exec(
    `"${CHROME_PATH}" --remote-debugging-port=${CDP_PORT} --new-window "https://app.getjobber.com/accounts/login"`,
    (err) => { if (err && !err.killed) console.error('[browserAuth] Chrome process error:', err.message); }
  );
  chromeProc.unref();
  console.log('[browserAuth] Chrome launched. Waiting 3s for CDP server to start...');

  // Step 3: Wait for Chrome to initialize its CDP server
  await new Promise(r => setTimeout(r, 3000));

  // Step 4: Connect Playwright to the running Chrome via CDP
  let browser;
  try {
    browser = await chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
    console.log('[browserAuth] Connected to Chrome via CDP');
  } catch (err) {
    throw new Error(`[browserAuth] Could not connect to Chrome via CDP: ${err.message}. Make sure Chrome is installed at: ${CHROME_PATH}`);
  }

  const context = browser.contexts()[0];
  if (!context) {
    await browser.disconnect();
    throw new Error('[browserAuth] No browser context found after CDP connection');
  }

  const page = context.pages()[0] || await context.newPage();

  let capturedToken = null;

  // Step 5: Intercept all requests to *.getjobber.com and grab first Bearer token
  page.on('request', req => {
    if (capturedToken) return;
    const url  = req.url();
    const auth = req.headers()['authorization'] || '';
    if (url.includes('getjobber.com') && auth.startsWith('Bearer ')) {
      capturedToken = auth.slice(7).trim();
      console.log('[browserAuth] Bearer token captured from:', url.slice(0, 80));
    }
  });

  // Navigate to Jobber login if not already there
  if (!page.url().includes('getjobber.com')) {
    console.log('[browserAuth] Navigating to Jobber login...');
    try {
      await page.goto('https://app.getjobber.com/accounts/login', { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch { /* navigation timeout ok — page may already be loading */ }
  }

  console.log('[browserAuth] Browser open — waiting for user to log in...');

  // Step 6: Wait for user to leave the login page
  try {
    await page.waitForURL(
      url => !url.includes('/accounts/login') && !url.includes('about:blank'),
      { timeout: timeoutMs }
    );
  } catch {
    await browser.disconnect();
    throw new Error('Login timed out. Click "Login via Browser" again and complete login within 5 minutes.');
  }

  console.log('[browserAuth] Login detected — waiting for Jobber API calls... URL:', page.url());

  // Wait for post-login GraphQL requests to fire
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(3000);

  // Navigate to invoices to force a GraphQL token if not captured yet
  if (!capturedToken) {
    console.log('[browserAuth] No token yet — navigating to /invoices to trigger API call...');
    try {
      await page.goto('https://app.getjobber.com/invoices', {
        waitUntil: 'networkidle',
        timeout: 15000,
      });
      await page.waitForTimeout(3000);
    } catch { /* timeout ok */ }
  }

  // Last resort: try the clients page
  if (!capturedToken) {
    console.log('[browserAuth] Still no token — trying /clients...');
    try {
      await page.goto('https://app.getjobber.com/clients', {
        waitUntil: 'networkidle',
        timeout: 15000,
      });
      await page.waitForTimeout(3000);
    } catch { /* timeout ok */ }
  }

  // Disconnect from CDP — leave Chrome open (user launched it natively)
  await browser.disconnect();

  if (!capturedToken) {
    throw new Error(
      'Could not capture a Jobber API token. ' +
      'Make sure you logged in fully, the dashboard loaded, and Jobber made API calls.'
    );
  }

  return capturedToken;
}

/**
 * Decode the captured JWT and save it to the JobberAccount table.
 * Sets refreshToken to '' since browser-captured tokens have no refresh token.
 *
 * @param {string} token - Raw JWT access token
 * @returns {{ accountId: string, expiresAt: Date }}
 */
async function saveJobberBrowserToken(token) {
  let accountId = 'browser-auth';
  let expiresAt = new Date(Date.now() + 60 * 60 * 1000); // default 1hr

  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64').toString('utf8')
    );
    if (payload.account_id) accountId = String(payload.account_id);
    else if (payload.sub)   accountId = String(payload.sub);
    if (payload.exp)        expiresAt = new Date(payload.exp * 1000);
  } catch {
    console.warn('[browserAuth] Could not decode JWT — using defaults for accountId/expiresAt');
  }

  await prisma.jobberAccount.upsert({
    where:  { accountId },
    create: { accountId, accessToken: token, refreshToken: '', expiresAt },
    update: { accessToken: token, refreshToken: '', expiresAt },
  });

  console.log(`[browserAuth] Token saved — account: ${accountId}, expires: ${expiresAt.toISOString()}`);
  return { accountId, expiresAt };
}

module.exports = { captureBrowserToken, saveJobberBrowserToken };
