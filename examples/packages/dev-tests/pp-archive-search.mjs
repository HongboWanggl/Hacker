// Legacy 检索 archives still render: the platform no longer creates 检索 tasks (the
// inline candidate panel replaced them), but archives written before that change are
// still reachable from 任务 and must rebuild their SearchCard from the stored
// report.json — the branch users kept landing on, and the one with no live task to
// fall back on. Skips (not fails) when the deployment has no such archive left.
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

const list = await page.request.get(`${base}api/archive`).then((r) => r.json())
const legacy = (Array.isArray(list) ? list : []).filter((e) => e?.type === 'search')
if (legacy.length === 0) {
  console.log('archive-search: SKIP (no type=search archive on this deployment)')
  await browser.close()
  process.exit(0)
}
const { taskId, title } = legacy[0]
console.log(`archive-search: opening ${taskId} (${title ?? 'no title'})`)

await page.goto(`${base}#/task/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pv-root', { timeout: 60000 })
await page
  .waitForFunction(() => /P[0-9A-Z]{5}|HBB|HBA/.test(document.querySelector('.pl-result')?.innerText ?? ''), {
    timeout: 60000,
  })
  .catch(() => {})
const body = (await page.textContent('.pl-result').catch(() => '')) ?? ''
if (!/P[0-9A-Z]{5}|HBB|HBA/.test(body))
  fail.push(`archived search page did not rebuild its candidate table: ${body.slice(0, 150)}`)
if (!/历史归档/.test(body)) fail.push('archived search page lacks the 历史归档 badge')
await page.screenshot({ path: '/tmp/pp-archive-search.png' })

// Row ▶ must still hand off to a prediction with no live task behind it (i.e. the
// accession comes from the archived report, not from memory state).
const singles = await page.evaluate(
  () => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]').filter((t) => t.type === 'single').length,
)
const predBtn = page.locator('.pv-search-predict').first()
if ((await predBtn.count()) === 0) {
  fail.push('predict ▶ missing on the archived search card')
} else {
  await predBtn.click()
  await page
    .waitForFunction(
      (n) =>
        JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]').filter((t) => t.type === 'single').length > n,
      singles,
      { timeout: 20000 },
    )
    .catch(() => fail.push('predict ▶ click did not start a single task'))
}

await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('archive-search probe: PASS')
