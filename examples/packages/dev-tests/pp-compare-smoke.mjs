// Compare smoke: complete a single task, click the AlphaFold compare button,
// wait for the NEW compare task (not the base task's badge) to finish, assert
// CompareCard renders.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
// PP_BASE/PP_USER/PP_PASS: drive a remote deployment (see pp-complex-full.mjs).
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const httpCreds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, ...(httpCreds ? { httpCredentials: httpCreds } : {}) })
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-composer textarea', { timeout: 15000 })
await page.fill('.pl-composer textarea', 'P69905')
await page.click('.pl-submit')
await page.goto(`${base}#/tasks`, { timeout: 15000 })
await page.waitForSelector('.pl-tasklist a.pl-taskrow:first-child .pl-badge.done', { timeout: 420000, state: 'attached' })
await page.click('a.pl-taskrow')
await page.waitForSelector('.pl-result', { timeout: 15000 })
const btn = page.locator('button.pl-back', { hasText: 'AlphaFold' }).first()
await btn.waitFor({ timeout: 60000, state: 'visible' }).catch(() => fail.push('compare button not visible'))
if (fail.length === 0) {
  await btn.click()
  // Wait until a second task (type compare) appears in the store, then until IT is done.
  await page.waitForFunction(
    () => {
      const t = JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')
      return t.length >= 2 && t[0].type === 'compare'
    },
    { timeout: 120000 },
  ).catch(() => fail.push('compare task never created'))
  await page.goto(`${base}#/tasks`, { timeout: 15000 })
  await page.waitForFunction(
    () => {
      const t = JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')
      return t[0]?.type === 'compare' && (t[0].status === 'done' || t[0].status === 'failed')
    },
    { timeout: 420000 },
  ).catch(() => {})
  const t = (await page.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')))[0]
  if (t?.status !== 'done') fail.push(`compare outcome: ${t?.status} ${t?.error ?? ''}`)
  // Compare archives too: hold the tab open until the archive lands, then
  // rebuild the page from a fresh context (report + both models, overlay ready).
  await page
    .waitForFunction(
      async (id) => {
        try {
          return (await fetch(`api/archive/${id}/meta`)).ok
        } catch {
          return false
        }
      },
      t.id,
      { timeout: 45000 },
    )
    .then(() => console.log('archive: landed'))
    .catch(() => fail.push('compare archive did not land within 45s'))
  await page.goto(`${base}#/task/${t.id}`, { timeout: 15000 })
  await page.waitForSelector('.pv-root', { timeout: 60000 }).catch(() => fail.push('no .pv-root'))
  await page
    .waitForFunction(() => /RMSD|一致性/i.test(document.querySelector('.pl-result')?.innerText ?? ''), { timeout: 60000 })
    .catch(() => {})
  const body = (await page.textContent('.pl-result').catch(() => '')) ?? ''
  if (!/RMSD|一致性/i.test(body)) fail.push(`CompareCard missing metrics: ${body.slice(0, 200)}`)
  await page.screenshot({ path: '/tmp/pp-compare-smoke.png' })
  // Fresh context: archived compare page must rebuild from the archive alone.
  const page2 = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
  // One reload retry: the mount-table flap can outlast the app's own retries.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page2.goto(`${base}#/task/${t.id}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    const root = await page2
      .waitForSelector('.pv-root', { timeout: 60000 })
      .then(() => true)
      .catch(() => false)
    if (root) break
    if (attempt === 1) fail.push('archived page2: no .pv-root')
    await page2.waitForTimeout(4000)
  }
  await page2
    .waitForFunction(() => /RMSD|一致性/i.test(document.querySelector('.pl-result')?.innerText ?? ''), { timeout: 30000 })
    .catch(() => {})
  const body2 = (await page2.textContent('.pl-result').catch(() => '')) ?? ''
  if (!/RMSD|一致性/i.test(body2)) fail.push('archived compare page missing metrics')
  if (!/历史归档/.test(body2)) fail.push('archived compare page lacks archive badge')
}
await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('compare smoke: PASS')
