// Natural-language input E2E: 「一句话描述 → 候选列表 → 用户确认 → 结构」.
//   1. composer in single mode receives a Chinese description
//   2. inspect strip must read it as 自然语言描述, submit creates a SEARCH task
//   3. the search result page renders candidate rows (SearchCard)
//   4. clicking a candidate's predict button starts a single prediction that
//      runs to 已完成 and renders the 3D canvas — the confirmation step works.
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
await page.fill('.pl-composer textarea', '人类血红蛋白 α 链')
const chip = await page
  .locator('.pl-inspect .pl-chip')
  .first()
  .textContent()
  .catch(() => null)
console.log('inspect chip:', chip)
if (!chip?.includes('自然语言')) fail.push(`inspect chip not 自然语言: ${chip}`)
await page.click('.pl-submit')
await page.goto(`${base}#/tasks`, { timeout: 15000 })
await page.waitForSelector('.pl-tasklist a.pl-taskrow', { timeout: 20000 })
const kind = await page.locator('.pl-tasklist a.pl-taskrow:first-child').textContent()
console.log('first row:', kind?.slice(0, 80))
if (!kind?.includes('检索')) fail.push(`first task row is not a search task: ${kind?.slice(0, 40)}`)

// Wait for the search to finish, then open the result page — candidates + predict.
const outcome = await page
  .waitForSelector(
    '.pl-tasklist a.pl-taskrow:first-child .pl-badge.done, .pl-tasklist a.pl-taskrow:first-child .pl-badge.failed',
    { timeout: 240000, state: 'attached' },
  )
  .then((el) => el.textContent())
  .catch(() => null)
if (outcome !== '已完成') {
  const t = await page.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')[0])
  fail.push(`search task ${outcome}: ${t?.error ?? ''}`)
} else {
  await page.click('a.pl-taskrow')
  await page.waitForSelector('.pl-result', { timeout: 15000 })
  // SearchCard rows carry one-click predict buttons (the confirmation step).
  await page
    .waitForSelector('.pv-root .pv-search-predict', { timeout: 60000 })
    .then(() => console.log('candidates rendered with per-row predict (▶)'))
    .catch(() => fail.push('no candidate predict buttons on search result page'))
  await page.screenshot({ path: '/tmp/pp-nl-candidates.png' })
  // Confirm: click the first candidate → a NEW single task starts.
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]').length)
  await page.click('.pv-root .pv-search-predict')
  await page.waitForTimeout(1500)
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]').length)
  if (after <= before) fail.push('clicking a candidate did not start a new task')
  await page.goto(`${base}#/tasks`, { timeout: 15000 })
  const finalOutcome = await page
    .waitForSelector(
      '.pl-tasklist a.pl-taskrow:first-child .pl-badge.done, .pl-tasklist a.pl-taskrow:first-child .pl-badge.failed',
      { timeout: 240000, state: 'attached' },
    )
    .then((el) => el.textContent())
    .catch(() => null)
  console.log('prediction outcome:', finalOutcome)
  if (finalOutcome !== '已完成') {
    const t = await page.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')[0])
    fail.push(`prediction task ${finalOutcome}: ${t?.error ?? ''}`)
  } else {
    await page.click('a.pl-taskrow')
    await page.waitForSelector('.pl-result', { timeout: 15000 })
    await page
      .waitForSelector('.pv-root canvas', { timeout: 90000 })
      .then(() => console.log('structure panel: canvas rendered'))
      .catch(() => fail.push('no canvas after candidate prediction'))
  }
}
await page.screenshot({ path: '/tmp/pp-nl-search.png' })
await browser.close()
if (fail.length) {
  console.log('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('nl-search probe: PASS')
