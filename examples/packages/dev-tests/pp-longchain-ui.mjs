// Product-path probe: what the wall SAYS when a long chain is submitted.
//
//   PP_BASE=http://118.25.194.247/platform/ PP_USER=… PP_PASS=… \
//     node pp-longchain-ui.mjs
//
// pp-longchain-e2e.mts drives the SDK directly and proves the tool refusals are
// honest. This probe drives the thing a judge actually touches: log in through
// the form, paste a long chain into the home composer, and then read the CARD.
// The 2026-10-15 incident was not a wrong error message — it was a green 「已完成」
// over an empty 3D slot, so the assertions here are about the card's status, its
// reason, and the absence of a 3D slot that has nothing behind it.
//
// Two entry points for the same wall: a UniProt ID (sequence fetched by the
// agent first) and a pasted raw sequence. Both must settle as failed with a
// reason, and neither may render a figure.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { loginViaUi } from './pp-login.mjs'

const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const creds = { username: process.env.PP_USER ?? '', password: process.env.PP_PASS ?? '' }
if (!creds.username) {
  console.error('PP_USER/PP_PASS required (owner account: the wall is per-browser)')
  process.exit(2)
}

const SETTLE_TIMEOUT_MS = 8 * 60_000
const syn = (n) => 'MKTAYIAKQRQISFVKSHFSRQ'.repeat(Math.ceil(n / 22)).slice(0, n)

const fail = []
const ok = (name, cond, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, extra)
  if (!cond) fail.push(name)
}

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
await loginViaUi(page, base, creds)

const tasks = () => page.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]'))
const cardText = (id) =>
  page
    .locator(`a.pl-card[href="#/task/${id}"]`)
    .first()
    .innerText()
    .catch(() => '')
const cardHasFig = (id) => page.locator(`a.pl-card[href="#/task/${id}"] .pl-card-fig`).count()

// The wall is this browser's own record; run against a fresh context per case so
// "which card is mine" is never a guess.
const cases = [
  { id: 'ui1-uniprot-2944', label: 'UniProt ID Q02388（COL7A1 2944 aa）', text: 'Q02388', want: /1000/ },
  { id: 'ui2-pasted-2944', label: '粘贴原始序列 2944 aa', text: syn(2944), want: /1000/ },
]

for (const c of cases) {
  const before = (await tasks()).length
  await page.goto(`${base}#/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.pl-home textarea', { timeout: 30_000 })
  // A first-time visitor gets the automated-session explainer; a real user
  // dismisses it, so the probe does too.
  const consent = page.locator('.pl-consent-ok')
  if (await consent.count())
    await consent
      .first()
      .click()
      .catch(() => {})
  await page.fill('.pl-home textarea', c.text)
  await page.click('.pl-submit')

  // The row is ours if the wall grew by one; take the newest.
  await page
    .waitForFunction((n) => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]').length > n, before, {
      timeout: 60_000,
    })
    .catch(() => {})
  const mine = (await tasks())[0]
  ok(`${c.id}: a task row was created`, !!mine && (await tasks()).length === before + 1)
  if (!mine) continue

  const t0 = Date.now()
  let row = mine
  while (Date.now() - t0 < SETTLE_TIMEOUT_MS) {
    row = (await tasks()).find((t) => t.id === mine.id) ?? row
    if (row.status !== 'running') break
    await page.waitForTimeout(3000)
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0)
  const reason = row.error ?? row.lastError ?? ''
  console.log(
    `     ${c.label} → status=${row.status} in ${secs}s · reason=${JSON.stringify(reason).slice(0, 160)}`,
  )

  ok(`${c.id}: settled (not still running)`, row.status !== 'running')
  // THE regression: a run that produced no structure must never read 已完成.
  ok(`${c.id}: NOT marked 已完成`, row.status !== 'done', `status=${row.status}`)
  ok(`${c.id}: carries a reason`, typeof reason === 'string' && reason.trim().length > 0)
  ok(`${c.id}: reason names the ceiling`, c.want.test(reason), reason.slice(0, 120))

  // …and the card the eye lands on agrees with the row.
  const text = await cardText(mine.id)
  ok(`${c.id}: card does not claim 已完成`, !text.includes('已完成'), text.replace(/\s+/g, ' ').slice(0, 80))
  ok(`${c.id}: card has no empty 3D slot`, (await cardHasFig(mine.id)) === 0)
  // Opening it must not be a dead end either: the detail page carries the error
  // banner and the 失败 badge, not a stale 已完成.
  await page.goto(`${base}#/task/${mine.id}`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  const banner =
    (await page
      .locator('.pl-error-banner')
      .first()
      .innerText()
      .catch(() => '')) ?? ''
  const badge =
    (await page
      .locator('.pl-result-head .pl-badge')
      .first()
      .innerText()
      .catch(() => '')) ?? ''
  ok(
    `${c.id}: task page shows an error banner`,
    banner.trim().length > 0,
    banner.replace(/\s+/g, ' ').slice(0, 120),
  )
  ok(`${c.id}: task page names the ceiling`, c.want.test(banner), banner.replace(/\s+/g, ' ').slice(0, 120))
  ok(`${c.id}: detail badge is not 已完成`, badge.trim() !== '已完成', badge)
  // A failed row must be retryable and deletable, not stuck.
  ok(`${c.id}: offers a retry`, (await page.locator('text=重新提交此任务').count()) > 0)
  await page.screenshot({ path: `/tmp/pp-longchain-ui-${c.id}.png`, fullPage: false })
}

await browser.close()
console.log(fail.length === 0 ? 'long-chain UI probe: PASS' : `long-chain UI probe: ${fail.length} FAILURES`)
process.exit(fail.length === 0 ? 0 : 1)
