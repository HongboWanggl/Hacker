// Search-page smoke: 检索页 now runs the same inline candidate lookup as the home box
// — results appear under the input, no 检索 task is created, no archive is written.
// (Coverage for the legacy 检索 task/archive rendering lives in pp-archive-search.mjs.)
//   PP_BASE/PP_USER/PP_PASS as usual.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { httpCredsFromEnv, login } from './pp-login.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const creds = httpCredsFromEnv()
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
if (creds) await login(page.request, base, creds)
page.on('pageerror', (e) => fail.push(`pageerror: ${String(e).slice(0, 160)}`))

const tasks = () => page.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]'))

await page.goto(`${base}#/search`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-input-name', { timeout: 20000 })
const before = (await tasks()).length
const archivesBefore = await page.request.get(`${base}api/archive`).then((r) => r.json().then((b) => (Array.isArray(b) ? b.length : -1)))

await page.fill('.pl-input-name', 'hemoglobin human')
await page.click('.pl-submit')
await page
  .waitForSelector('.pl-candidates .pv-root .pv-search-row', { timeout: 60000 })
  .then(() => console.log('inline candidates rendered on the search page'))
  .catch(() => fail.push('no inline candidate rows on the search page'))
const hash = await page.evaluate(() => location.hash)
if (hash !== '#/search') fail.push(`search submit navigated away: ${hash}`)

const body = (await page.textContent('.pl-candidates').catch(() => '')) ?? ''
if (!/P6\d{4}|HBB|HBA/.test(body)) fail.push(`candidates lack accessions: ${body.slice(0, 150)}`)
if ((await tasks()).length !== before) fail.push('search page lookup added a task row')
const archivesAfter = await page.request.get(`${base}api/archive`).then((r) => r.json().then((b) => (Array.isArray(b) ? b.length : -1)))
if (archivesAfter !== archivesBefore) fail.push(`lookup wrote an archive entry (${archivesBefore} → ${archivesAfter})`)
await page.screenshot({ path: '/tmp/pp-search-smoke.png' })

// The confirmation step: row ▶ hands the accession to a single prediction.
const singles = (await tasks()).filter((t) => t.type === 'single').length
await page.click('.pl-candidates .pv-search-predict')
await page
  .waitForFunction(
    (n) => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]').filter((t) => t.type === 'single').length > n,
    singles,
    { timeout: 20000 },
  )
  .catch(() => fail.push('predict ▶ click did not start a single task'))

await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('search smoke: PASS')
