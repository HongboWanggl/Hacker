// Cancel smoke: submit a REAL single task (cancelTask only exists for live
// runners — a seeded fake would find no runner), then in the task list arm and
// confirm 取消 while it is running, and require the badge to settle at 已取消
// (not 失败 — a user cancel must not look like an error, nor auto-retry).
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { login } from './pp-login.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
// PP_BASE/PP_USER/PP_PASS: drive a remote deployment (see pp-complex-full.mjs).
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const httpCreds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, ...(httpCreds ? { httpCredentials: httpCreds } : {}) })
if (httpCreds) await login(page.request, base, httpCreds)
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-composer textarea', { timeout: 15000 })
await page.fill('.pl-composer textarea', 'P69905')
await page.click('.pl-submit')
await page.goto(`${base}#/tasks`, { timeout: 15000 })

// Wait for the live running row (first row in the store = this task).
await page
  .waitForFunction(
    () => {
      const t = JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')
      return t[0]?.status === 'running'
    },
    { timeout: 60000 },
  )
  .catch(() => fail.push('task never started running'))

if (fail.length === 0) {
  const row = page.locator('a.pl-taskrow').first()
  await row.waitFor({ timeout: 15000, state: 'visible' })
  // Two-click arm: 取消 → 确认取消. First assert the armed state exists (the
  // arm must NOT abort anything), then confirm.
  await row.locator('button.pl-row-del', { hasText: '取消' }).click()
  const armed = row.locator('button.pl-row-del', { hasText: '确认取消' })
  await armed.waitFor({ timeout: 5000, state: 'visible' }).catch(() => fail.push('cancel did not arm'))
  if (fail.length === 0) {
    await armed.click()
    await page
      .waitForFunction(
        () => {
          const t = JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')
          return t[0]?.status === 'cancelled'
        },
        { timeout: 60000 },
      )
      .catch(() => fail.push('task never settled to cancelled'))
    // Badge on the row shows 已取消 and no auto-retry resurrected it.
    await page
      .waitForSelector('a.pl-taskrow:first-child .pl-badge.cancelled', { timeout: 15000, state: 'attached' })
      .catch(() => fail.push('row badge not 已取消'))
    await page.screenshot({ path: '/tmp/pp-cancel-smoke.png' })
  }
}
// Leg 2: same flow from the RESULT page (cancelRunning in the stage block) —
// a different button in a different view over the same cancelTask.
if (fail.length === 0) {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.pl-composer textarea', { timeout: 15000 })
  await page.fill('.pl-composer textarea', 'P69905')
  await page.click('.pl-submit')
  const id = await page.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')[0].id)
  await page.goto(`${base}#/task/${id}`, { timeout: 15000 })
  await page.waitForSelector('.pl-stage-wrap', { timeout: 30000 }).catch(() => fail.push('stage block missing'))
  if (fail.length === 0) {
    const btn = page.locator('.pl-stage-wrap button.pl-row-del', { hasText: '取消' })
    await btn.waitFor({ timeout: 15000, state: 'visible' }).catch(() => fail.push('result-page cancel button missing'))
    if (fail.length === 0) {
      await btn.click()
      await page
        .locator('.pl-stage-wrap button.pl-row-del', { hasText: '确认取消' })
        .click()
      await page
        .waitForFunction(
          () => {
            const t = JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')[0]
            return t.status === 'cancelled'
          },
          { timeout: 60000 },
        )
        .catch(() => fail.push('result-page cancel never settled'))
    }
  }
}
await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('cancel smoke: PASS')
