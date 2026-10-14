// Auto-retry probe: locks the bounded transient-failure retry (orchestrator
// runTask + transient.ts). Deterministic transient failure = the first
// POST api/task (task-dir creation) is answered 503 via route interception —
// a real HTTP 5xx the client must classify as transient and resubmit on a
// fresh attempt. Pass = exactly 2 attempts and the task still lands 已完成
// with a rendered 3D canvas.
//   PP_BASE/PP_USER/PP_PASS as usual.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { login } from './pp-login.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const creds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
if (creds) await login(ctx.request, base, creds)
const page = await ctx.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[console.error]`, m.text().slice(0, 200))
})

// One-shot 503 on the task-dir creation: transient by contract (HTTP 5xx).
let taskPosts = 0
await page.route('**/api/task', (route) => {
  taskPosts++
  if (taskPosts === 1) void route.fulfill({ status: 503, body: 'probe: simulated transient' })
  else void route.continue()
})

await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-composer textarea', { timeout: 15000 })
// single is the default tab — a raw short sequence keeps the run quick.
await page.fill('.pl-composer textarea', 'MVLSPADKTNVKAAWGKVGAHAGEYGAEAL')
await page.click('.pl-submit')

// The first attempt must fail fast (503) and the retry loop must resubmit —
// watch the task settle on the wall; never cancelled, and not stuck 运行中.
await page.goto(`${base}#/tasks`, { timeout: 15000 })
await page.waitForSelector('.pl-tasklist a.pl-taskrow', { timeout: 20000 })
const outcome = await page
  .waitForSelector(
    '.pl-tasklist a.pl-taskrow:first-child .pl-badge.done, .pl-tasklist a.pl-taskrow:first-child .pl-badge.failed, .pl-tasklist a.pl-taskrow:first-child .pl-badge.cancelled',
    { timeout: 240000, state: 'attached' },
  )
  .then((el) => el.textContent())
  .catch(() => null)
console.log('outcome:', outcome)

const t = await page.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')[0])
console.log(
  'task:',
  JSON.stringify({
    id: t?.id,
    status: t?.status,
    error: t?.error ?? null,
    savedToKeys: Object.keys(t?.savedTo ?? {}).length,
    resultSavedTo: t?.resultSavedTo ?? null,
    archived: !!t?.archived,
  }),
)
if (outcome !== '已完成') fail.push(`task settled as ${outcome}: ${t?.error ?? ''}`)
if (taskPosts < 2) fail.push(`expected 2 api/task attempts (first 503 + retry), saw ${taskPosts}`)
if (taskPosts > 2) fail.push(`unexpected extra attempts: ${taskPosts} api/task posts`)

// The retried run must produce a real result — 3D canvas rendered.
await page.click('a.pl-taskrow')
await page.waitForSelector('.pl-result', { timeout: 15000 })
await page
  .waitForSelector('.pv-root canvas', { timeout: 90000 })
  .then(() => console.log('structure panel: canvas rendered after auto-retry'))
  .catch(() => fail.push('no canvas after auto-retried task'))

await page.screenshot({ path: '/tmp/pp-auto-retry.png' })
await browser.close()
if (fail.length) {
  console.log('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('auto-retry probe: PASS')
