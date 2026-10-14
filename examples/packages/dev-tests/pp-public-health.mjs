// Public-deployment health probe — cheap, repeatable, and side-effect free.
//
// This is the probe to run on a timer: it exercises the parts that break silently
// (the WS url baked into the surface config, the served bundle, the server-side
// UniProt proxy, the candidate panel) and deliberately never clicks ▶, so it adds
// no task rows and no archive entries to the reviewer-facing platform.
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
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 160))
})

const tasks = () => page.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]'))
const archiveCount = () =>
  page.evaluate(async () => {
    try {
      const r = await fetch('api/archive')
      const b = await r.json()
      return Array.isArray(b) ? b.length : -1
    } catch {
      return -1
    }
  })

// 1. The platform loads and its live link to the daemon is up. A loopback wsUrl in
//    the published surface config is the classic silent break: the archive still
//    looks fine while every live event stream is dead.
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-composer textarea', { timeout: 30000 })
const cfg = await page.evaluate(async () => {
  try {
    return await (await fetch('config.json')).json()
  } catch {
    return null
  }
})
if (!cfg?.wsUrl) fail.push(`no wsUrl in config.json (${JSON.stringify(cfg)?.slice(0, 120)})`)
else {
  console.log('wsUrl:', cfg.wsUrl)
  if (/127\.0\.0\.1|localhost/.test(cfg.wsUrl)) fail.push(`surface wsUrl is loopback: ${cfg.wsUrl}`)
}
await page
  .locator('.pl-status', { hasText: '服务正常' })
  .waitFor({ timeout: 30000 })
  .then(() => console.log('status: 服务正常'))
  .catch(async () => fail.push(`status stuck: ${await page.textContent('.pl-status').catch(() => '?')}`))

// 2. The server-side UniProt proxy answers with real hits (this is what the
//    candidate panel depends on; the browser itself cannot reach UniProt).
const before = { tasks: (await tasks()).length, archive: await archiveCount() }
const probe = await page.evaluate(async () => {
  try {
    const r = await fetch('api/uniprot?q=hemoglobin%20human&limit=3')
    return { status: r.status, body: await r.json() }
  } catch (e) {
    return { status: 0, body: { error: String(e) } }
  }
})
console.log(`api/uniprot: HTTP ${probe.status} ok=${probe.body?.ok} hits=${probe.body?.hits?.length ?? '-'}`)
if (probe.status !== 200 || probe.body?.ok !== true || !(probe.body?.hits?.length > 0))
  fail.push(`api/uniprot unhealthy: ${JSON.stringify(probe).slice(0, 200)}`)

// 3. The inline candidate panel renders in place. Fast path only (an English query),
//    and nothing is clicked afterwards — a lookup must leave no trace.
await page.fill('.pl-composer textarea', 'hemoglobin human')
await page.click('.pl-submit')
await page
  .waitForSelector('.pl-candidates .pv-root .pv-search-row', { timeout: 45000 })
  .then(() => console.log('candidate panel: rows rendered in place'))
  .catch(() => fail.push('candidate panel did not render rows'))
const body = (await page.textContent('.pl-candidates').catch(() => '')) ?? ''
if (!/P[0-9A-Z]{5}|HBB|HBA/.test(body)) fail.push(`candidate rows lack accessions: ${body.slice(0, 120)}`)
const after = { tasks: (await tasks()).length, archive: await archiveCount() }
if (after.tasks !== before.tasks || after.archive !== before.archive)
  fail.push(
    `lookup left a trace (tasks ${before.tasks}→${after.tasks}, archive ${before.archive}→${after.archive})`,
  )
console.log(`archive: ${after.archive} entries (unchanged)`)

await browser.close()
if (fail.length) {
  console.log('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('public health: PASS')
