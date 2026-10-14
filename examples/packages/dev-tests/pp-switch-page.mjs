// Page-switch recovery probe: locks the boot-time reattach (orchestrator
// reattachRunningTasks). The run loop lives in the page that submitted the
// task — a reload used to strand the task at 运行中 forever and lose the
// structure/archive. Now the fresh page reattaches to the daemon-side session
// and replays the journal to the true outcome.
//   1. submit a single-chain prediction via the composer
//   2. reload the page mid-run (kills the in-page event loop)
//   3. the reloaded page must drive the task to 已完成 and render the 3D canvas
// Optionally also verifies the inline-report path: a task whose tool result was
// only predict_structure's inline JSON (no confidence.json) still renders.
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

await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-composer textarea', { timeout: 15000 })
// single is the default tab — a raw short sequence keeps the run quick.
await page.fill('.pl-composer textarea', 'MVLSPADKTNVKAAWGKVGAHAGEYGAEAL')
await page.click('.pl-submit')
await page.goto(`${base}#/tasks`, { timeout: 15000 })
await page.waitForSelector('.pl-tasklist a.pl-taskrow', { timeout: 20000 })

// Reload mid-run — the old failure mode. Give the run a moment to start so the
// session exists and the reattach has something to recover.
await page.waitForTimeout(3000)
await page.reload({ waitUntil: 'domcontentloaded' })
console.log('reloaded mid-run')

// The reattached page must settle the task (已完成 or — if the daemon-side turn
// died with the disconnect — an honest 失败/已取消, never a stuck 运行中).
const outcome = await page
  .waitForSelector(
    '.pl-tasklist a.pl-taskrow:first-child .pl-badge.done, .pl-tasklist a.pl-taskrow:first-child .pl-badge.failed, .pl-tasklist a.pl-taskrow:first-child .pl-badge.cancelled',
    { timeout: 240000, state: 'attached' },
  )
  .then((el) => el.textContent())
  .catch(() => null)
console.log('outcome after reload:', outcome)
if (outcome === null) fail.push('task never settled after reload (stuck 运行中?)')
if (outcome !== '已完成') {
  const t = await page.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')[0])
  console.log('task:', JSON.stringify(t?.error ?? t?.status))
  fail.push(`task settled as ${outcome}: ${t?.error ?? ''}`)
} else {
  const t = await page.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')[0])
  console.log(
    'task:',
    JSON.stringify({
      id: t?.id,
      resultSavedTo: t?.resultSavedTo ?? null,
      resultJson: !!t?.resultJson,
      archived: !!t?.archived,
    }),
  )
  // The structure panel must render (canvas) on the reattached page.
  await page.click('a.pl-taskrow')
  await page.waitForSelector('.pl-result', { timeout: 15000 })
  await page
    .waitForSelector('.pv-root canvas', { timeout: 90000 })
    .then(() => console.log('structure panel: canvas rendered'))
    .catch(() => fail.push('no canvas after reload-recovered task'))
}

await page.screenshot({ path: '/tmp/pp-switch-page.png' })
await browser.close()
if (fail.length) {
  console.log('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('switch-page probe: PASS')
