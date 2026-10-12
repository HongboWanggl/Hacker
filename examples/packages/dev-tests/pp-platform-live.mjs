// Live E2E for the protein platform SPA mounted at /platform.
// Flow: home → submit UniProt accession → stage checklist completes →
// open result → Structure3D canvas + pLDDT curve render → screenshot.
//   node pp-platform-live.mjs [--shots]
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const SHOTS = process.argv.includes('--shots')
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
// PP_BASE/PP_USER/PP_PASS: drive a remote deployment (see pp-complex-full.mjs).
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const httpCreds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const fail = []

const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({
  viewport: { width: 1400, height: 1000 },
  deviceScaleFactor: 2,
  ...(httpCreds ? { httpCredentials: httpCreds } : {}),
})
try {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.pl-composer textarea', { timeout: 15000 })
  const status = await page.textContent('.pl-status')
  if (!/已连接|connected|服务正常/i.test(status ?? '')) fail.push(`status dot: ${status}`)

  await page.fill('.pl-composer textarea', 'P69905')
  await page.fill('.pl-input-name', 'E2E 血红蛋白α')
  await page.click('.pl-submit')
  await page.waitForSelector('.pl-card, .pl-tasklist', { timeout: 10000 })

  // Badges live on the #/tasks list (home cards show score/verdict instead), so go
  // there and wait for the run to finish (ESMFold on 142aa takes tens of seconds).
  await page.goto(`${base}#/tasks`, { timeout: 15000 })
  const outcome = await page
    .waitForSelector('.pl-tasklist a.pl-taskrow:first-child .pl-badge.done, .pl-tasklist a.pl-taskrow:first-child .pl-badge.failed, .pl-tasklist a.pl-taskrow:first-child .pl-badge.cancelled', {
      timeout: 420000,
      state: 'attached',
    })
    .then((el) => el.textContent())
    .catch(() => null)
  if (outcome !== '已完成') fail.push(`task outcome: ${outcome}`)

  // Open the result workbench (first row = newest task).
  await page.click('a.pl-taskrow', { timeout: 10000 })
  await page.waitForSelector('.pl-result', { timeout: 15000 })
  await page.waitForSelector('.pv-root canvas', { timeout: 60000 })
  const canvasBox = await page.locator('.pv-root canvas').first().boundingBox()
  if (!canvasBox || canvasBox.width < 300) fail.push(`3d canvas too small: ${JSON.stringify(canvasBox)}`)
  const curve = await page.locator('.pv-root svg, .pv-root .pv-curve, .pv-root canvas').count()
  if (curve < 2) fail.push(`expected ≥2 pv visual stages, got ${curve}`)

  if (SHOTS) {
    await page.screenshot({
      path: new URL('../docs/screenshots/platform-result-live.png', import.meta.url).pathname,
      fullPage: true,
    })
  }
} catch (e) {
  fail.push(`exception: ${e.message}`)
}
await browser.close()
if (fail.length) {
  console.log('FAILED:\n- ' + fail.join('\n- '))
  process.exit(1)
}
console.log('platform live E2E: PASS')
