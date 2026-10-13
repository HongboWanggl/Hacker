// Batch per-target compare smoke: an archived batch page's expanded drill-down
// exposes a ⇄ 对比 button (platform-only onCompare hand-off); clicking it seeds
// that job's archived PDB into a fresh compare session and lands a new task.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
// PP_BASE/PP_USER/PP_PASS: drive a remote deployment (see pp-complex-full.mjs).
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const httpCreds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const origin = new URL(base).origin
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, ...(httpCreds ? { httpCredentials: httpCreds } : {}) })
page.on('console', (msg) => {
  const t = msg.text()
  if (/archive|orchestrat|compare seed/i.test(t)) console.log('  [console]', t.slice(0, 200))
})
page.on('pageerror', (err) => console.log('  [pageerror]', String(err).slice(0, 200)))

// Latest archived batch run with at least one ok job.
const list = await (await page.request.get(`${base}api/archive`, { headers: { origin } })).json()
const batch = list.find((m) => m.type === 'batch' && (m.jobPdbs?.length ?? 0) > 0)
if (!batch) {
  console.error('SKIP: no archived batch run with job PDBs')
  process.exit(0)
}

await page.goto(`${base}#/task/${batch.taskId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pv-batch-row', { timeout: 20000 }).catch(() => fail.push('batch rows missing'))
// Expand the first successful row (rows with a caret toggle the drill-down).
await page.locator('.pv-batch-row', { has: page.locator('.pv-batch-caret') }).first().click()
await page.waitForSelector('.pv-batch-detail', { timeout: 20000 }).catch(() => fail.push('drill-down did not open'))
await page.waitForSelector('.pv-batch-detail canvas.pv-3d, .pv-batch-detail .pv-spinner', { timeout: 20000 }).catch(() => fail.push('detail content missing'))
// The expanded row's accession — the table order is the report's, which need
// not match the archive meta's jobPdbs order, so read it from the detail itself.
const expandedAcc = await page
  .locator('.pv-batch-detail .pv-section-title')
  .first()
  .textContent()
  .then((t) => (t ?? '').trim().split(/\s+/)[0])
if (!expandedAcc) fail.push('could not read expanded row accession')

// The platform-only compare button must exist in the drill-down toolbar.
const cmpBtn = page.locator('.pv-batch-detail button', { hasText: '⇄ 对比' }).first()
await cmpBtn.waitFor({ timeout: 20000, state: 'attached' }).catch(() => fail.push('⇄ 对比 button missing in drill-down'))

const before = await page.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]').length).catch(() => 0)
await cmpBtn.click().catch(() => fail.push('compare click failed'))
await page.waitForURL(/#\/tasks/, { timeout: 15000 }).catch(() => fail.push('did not navigate to #/tasks'))
await page.waitForTimeout(1500)
const after = await page.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')).catch(() => [])
const newTask = (after.length > before ? after[0] : null) ?? after.find((t) => t.type === 'compare')
if (!newTask) fail.push('no new compare task in task store')
else {
  console.log(`new compare task: ${newTask.id} accession=${newTask.input?.accession} status=${newTask.status}`)
  if (expandedAcc && newTask.input?.accession?.toUpperCase() !== expandedAcc.toUpperCase())
    fail.push(`compare accession mismatch: ${newTask.input?.accession} (want ${expandedAcc})`)
  // The archive write happens from the page on completion — closing the browser
  // now would orphan the turn. Wait for the seeded compare to actually finish
  // (a lost seed fails fast; a real comparison takes a couple of minutes).
  const done = await page
    .waitForFunction(
      (id) => {
        const ts = JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')
        const t = ts.find((x) => x.id === id)
        return t && ['done', 'failed', 'cancelled'].includes(t.status) ? t.status : false
      },
      newTask.id,
      { timeout: 360000, polling: 5000 },
    )
    .catch(() => null)
    .then((h) => (h && typeof h.jsonValue === 'function' ? h.jsonValue() : h))
  if (done !== 'done') fail.push(`compare task did not complete (got ${JSON.stringify(done)})`)
  else {
    const rec = await page.evaluate((id) => {
      const ts = JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')
      const t = ts.find((x) => x.id === id)
      return { archived: t?.archived, resultSavedTo: t?.resultSavedTo, sessionId: !!t?.sessionId }
    }, newTask.id)
    console.log('  [task rec]', JSON.stringify(rec))
  }
  if (done === 'done') {
    // The page archives on completion (report fetch → POST can trail the status
    // flip by a moment) — poll briefly, server-side.
    let meta = null
    for (let i = 0; i < 10 && !meta; i++) {
      await page.waitForTimeout(1500)
      meta = await page.request
        .get(`${base}api/archive/${newTask.id}/meta`, { headers: { origin } })
        .then((r) => r.text())
        .then((txt) => (txt.startsWith('{') ? JSON.parse(txt) : null))
        .catch(() => null)
    }
    if (!meta?.taskId) fail.push(`archive meta missing for compare task ${newTask.id}`)
    else console.log(`compare archived: ${meta.taskId} verdict=${JSON.stringify(meta.verdict ?? null)}`)
  }
}

await page.screenshot({ path: '/tmp/pp-batch-compare.png' })
await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('batch per-target compare smoke: PASS')
