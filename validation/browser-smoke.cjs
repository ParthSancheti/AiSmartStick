// Optional browser smoke: uses an existing Playwright installation, no application dependency.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright-core');
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.APP_URL || 'http://127.0.0.1:5200', { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Set up SmartStick' }).waitFor();
    await page.keyboard.press('d');
    await page.getByRole('button', { name: 'Close demo controls' }).click();
    await page.keyboard.press('v');
    await page.getByText(/LOCAL PLAN/).first().waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(JSON.stringify({ onboarding: 'rendered', demoControls: 'opened and closed', existingDebugOverlay: 'opened and closed with local diagnostics', pageErrors: errors.length }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
