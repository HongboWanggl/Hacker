// Home-page inline candidates: 「一句话描述 → 候选当场出现在输入框下方 → 单选/多选 → 直接预测」.
//   1. composer reads a Chinese description as 自然语言描述
//   2. submit does NOT navigate: the candidate panel opens under the box (the old flow
//      created a 检索 task, which was the whole complaint — it left an unopenable,
//      preview-less row behind and forced a detour through 任务)
//   3. the lookup leaves no trace: no task row in localStorage, no entry in api/archive
//   4. row ▶ = single-select → exactly ONE `single` task, runs to 已完成, canvas renders
//   5. tick two rows + batch bar = multi-select → exactly ONE `batch` task
// The Chinese leg exercises the agent fallback (UniProt cannot match CJK prose), so
// expect ~10–25 s between submit and the table; the multi-select leg uses an English
// query to stay on the fast path — the batch-bar wiring is identical either way.
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
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 200))
})
page.on('pageerror', (e) => fail.push(`pageerror: ${String(e).slice(0, 160)}`))

const tasks = () => page.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]'))
const archiveCount = () =>
  page.evaluate(async () => {
    try {
      const r = await fetch('api/archive')
      const body = await r.json()
      return Array.isArray(body) ? body.length : -1
    } catch {
      return -1
    }
  })

// Submit a description and wait for the candidate table to render in place.
const lookup = async (query, label) => {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.pl-composer textarea', { timeout: 20000 })
  const before = { tasks: (await tasks()).length, archive: await archiveCount() }
  await page.fill('.pl-composer textarea', query)
  const chip = await page
    .locator('.pl-inspect .pl-chip')
    .first()
    .textContent()
    .catch(() => null)
  if (!chip?.includes('自然语言')) fail.push(`${label}: inspect chip not 自然语言: ${chip}`)

  await page.click('.pl-submit')
  // Progress must be visible and cancellable while it runs — never a blank wait.
  await page
    .waitForSelector('.pl-candidates', { timeout: 5000 })
    .then(() => console.log(`${label}: panel opened under the box`))
    .catch(() => fail.push(`${label}: no .pl-candidates panel after submit`))
  const hashAfterSubmit = await page.evaluate(() => location.hash)
  if (hashAfterSubmit && hashAfterSubmit !== '#/') fail.push(`${label}: submit navigated to ${hashAfterSubmit}`)

  await page
    .waitForSelector('.pl-candidates .pv-root .pv-search-row', { timeout: 150000 })
    .then(() => console.log(`${label}: candidate rows rendered in place`))
    .catch(async () => {
      // Print what the panel is actually showing — "still spinning" and "honest
      // error text" both fail this step, and they need different fixes.
      const text = (await page.textContent('.pl-candidates').catch(() => null)) ?? '(no panel)'
      const msg = `${label}: no candidate rows within 150s — panel shows: ${JSON.stringify(text.slice(0, 200))}`
      fail.push(msg)
      console.log('DIAG', msg)
      await page.screenshot({ path: `/tmp/pp-nl-fail-${label}.png` }).catch(() => {})
    })

  // No trace: a lookup is not a task, and it writes nothing to the archive store.
  const after = { tasks: (await tasks()).length, archive: await archiveCount() }
  const body = (await page.textContent('.pl-candidates').catch(() => '')) ?? ''
  if (!/P6\d{4}|HBB|HBA/.test(body)) fail.push(`${label}: candidates lack accessions: ${body.slice(0, 160)}`)
  if (after.tasks !== before.tasks)
    fail.push(`${label}: lookup added a task row (${before.tasks} → ${after.tasks})`)
  if (after.archive !== before.archive)
    fail.push(`${label}: lookup wrote an archive entry (${before.archive} → ${after.archive})`)
  console.log(`${label}: no trace (tasks ${before.tasks}→${after.tasks}, archive ${before.archive}→${after.archive})`)
  return { tasks: before.tasks }
}

const waitDone = async (label, timeout = 300000) => {
  const outcome = await page
    .waitForSelector(
      '.pl-tasklist a.pl-taskrow:first-child .pl-badge.done, .pl-tasklist a.pl-taskrow:first-child .pl-badge.failed',
      { timeout, state: 'attached' },
    )
    .then((el) => el.textContent())
    .catch(() => null)
  if (outcome !== '已完成') {
    const t = (await tasks())[0]
    fail.push(`${label}: ${outcome}: ${t?.error ?? ''} ${t?.status ?? ''}`)
  } else console.log(`${label}: 已完成`)
  return outcome
}

// --- single-select: the description a user actually types -------------------
await lookup('人类血红蛋白 α 链', 'single')
await page.screenshot({ path: '/tmp/pp-nl-candidates.png' })
if (fail.length === 0) {
const beforeSingle = (await tasks()).filter((t) => t.type === 'single').length
await page.click('.pl-candidates .pv-root .pv-search-predict')
await page
  .waitForFunction(
    (n) => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]').filter((t) => t.type === 'single').length > n,
    beforeSingle,
    { timeout: 20000 },
  )
  .then(() => console.log('row ▶ started a single task'))
  .catch(() => fail.push('row ▶ did not start a single task'))
const afterSingle = (await tasks()).filter((t) => t.type === 'single').length
if (afterSingle !== beforeSingle + 1)
  fail.push(`expected exactly 1 new single task (${beforeSingle} → ${afterSingle})`)
await page.waitForFunction(() => location.hash === '#/tasks', { timeout: 10000 }).catch(() => {})
await page.waitForSelector('.pl-tasklist a.pl-taskrow', { timeout: 20000 })
if ((await waitDone('single prediction')) === '已完成') {
  await page.click('a.pl-taskrow')
  await page.waitForSelector('.pl-result', { timeout: 15000 })
  await page
    .waitForSelector('.pv-root canvas', { timeout: 90000 })
    .then(() => console.log('structure panel: canvas rendered'))
    .catch(() => fail.push('no canvas after candidate prediction'))
  await page.screenshot({ path: '/tmp/pp-nl-single.png' })
}
}

// --- multi-select: tick two rows, use the batch bar -------------------------
if (fail.length === 0) {
await lookup('hemoglobin human', 'batch')
const beforeBatch = (await tasks()).filter((t) => t.type === 'batch').length
await page.locator('.pv-search-row .pv-search-check').nth(0).click()
await page.locator('.pv-search-row .pv-search-check').nth(1).click()
const bar = page.locator('.pl-candidates .pv-batchbar button', { hasText: '批量预测所选' })
await bar
  .waitFor({ timeout: 10000, state: 'visible' })
  .then(async () => {
    const text = await bar.textContent()
    console.log('batch bar:', text)
    if (!/（2）/.test(text ?? '')) fail.push(`batch bar did not count 2 selections: ${text}`)
  })
  .catch(() => fail.push('batch bar did not appear after ticking two rows'))
if (fail.length === 0) {
  await bar.click()
  await page
    .waitForFunction(
      (n) => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]').filter((t) => t.type === 'batch').length > n,
      beforeBatch,
      { timeout: 20000 },
    )
    .then(() => console.log('batch bar started a batch task'))
    .catch(() => fail.push('batch bar did not start a batch task'))
}
const afterBatch = (await tasks()).filter((t) => t.type === 'batch').length
if (afterBatch !== beforeBatch + 1) fail.push(`expected exactly 1 new batch task (${beforeBatch} → ${afterBatch})`)
await page.waitForSelector('.pl-tasklist a.pl-taskrow', { timeout: 20000 })
await waitDone('batch prediction')
await page.screenshot({ path: '/tmp/pp-nl-batch.png' })
}

await browser.close()
if (fail.length) {
  console.log('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('nl-search probe: PASS')
