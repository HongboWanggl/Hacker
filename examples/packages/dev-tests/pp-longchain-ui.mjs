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
// agent first) and a pasted raw sequence. Either may settle 已完成 — as long as a
// structure is actually there — but a run that produced nothing must settle with
// a reason that names its cause, and never with a shrug.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { loginViaUi } from './pp-login.mjs'

const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const creds = { username: process.env.PP_USER ?? '', password: process.env.PP_PASS ?? '' }
if (!creds.username) {
  console.error('PP_USER/PP_PASS required (owner account: the wall is per-browser)')
  process.exit(2)
}

// Long enough for a domain-split Boltz run to finish: single-type tasks widen
// their watchdog to the complex window once predict_complex is observed, and the
// platform's own cap is 20 minutes. A shorter settle would report "still running"
// as a failure and hide the very outcome we are testing for.
const SETTLE_TIMEOUT_MS = 24 * 60_000
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
//
// `useless` is the 2026-10-15 regression in one regex: `turn blocked` named no
// tool and no cause, and `This operation was aborted` hid the stall watchdog
// (and, because neither matched TRANSIENT_RE, silently disabled the auto-retry).
// A card may fail, but it may not fail with a shrug.
const USELESS = /^\s*(turn blocked|This operation was aborted|aborted|unknown|error)\s*$/i
const cases = [
  {
    id: 'ui1-uniprot-2944',
    label: 'UniProt ID Q02388（COL7A1 2944 aa）',
    text: 'Q02388',
    want: /1000/,
    useless: USELESS,
  },
  { id: 'ui2-pasted-2944', label: '粘贴原始序列 2944 aa', text: syn(2944), want: /1000/, useless: USELESS },
  // The capstone for "is the ceiling a blanket ban?": androgen receptor P10275
  // at 920 aa sits UNDER it, so this run must reach 已完成 with a real
  // structure. It is the case that distinguishes "we refuse what the folding
  // engines cannot do" from "we refuse anything large", and it is the only case
  // here that spends real GPU time (ESMFold 413s above ~400 aa, so the agent
  // falls back to a local Boltz-2 run — minutes, not seconds).
  {
    id: 'ui3-under-ceiling-920',
    label: 'UniProt ID P10275（雄激素受体 920 aa，天花板之下）',
    text: 'P10275',
    want: /1000/,
    useless: USELESS,
    mustSucceed: true,
  },
]

// Optional case-id filter: `node pp-longchain-ui.mjs ui3-under-ceiling-920`
const only = process.argv.slice(2)
const selected = only.length ? cases.filter((c) => only.includes(c.id)) : cases
if (!selected.length) {
  console.error(`no such case. known: ${cases.map((c) => c.id).join(', ')}`)
  process.exit(2)
}

for (const c of selected) {
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

  // …and the card the eye lands on agrees with the row.
  const text = await cardText(mine.id)
  const figs = await cardHasFig(mine.id)
  const done = row.status === 'done'
  ok(
    `${c.id}: card text agrees with the row`,
    done === text.includes('已完成'),
    text.replace(/\s+/g, ' ').slice(0, 80),
  )
  // THE regression, and the only shape that actually matters: 已完成 is a claim
  // about a structure, so it must be backed by one. The inverse is NOT required
  // — since approvals flow again the agent can take the domain-split route it
  // was previously refused, so a long chain may legitimately finish as done.
  ok(`${c.id}: a 已完成 row renders a structure`, !done || figs > 0, `status=${row.status} figs=${figs}`)
  // …except for the under-ceiling case, where folding IS the product: a 920-aa
  // chain that ends 失败 means the ceiling has become a blanket ban.
  if (c.mustSucceed)
    ok(
      `${c.id}: a chain under the ceiling actually folds`,
      done && figs > 0,
      `status=${row.status} figs=${figs}`,
    )
  // A run with nothing behind it must say why, and say something USEFUL.
  ok(`${c.id}: carries a reason`, typeof reason === 'string' && reason.trim().length > 0)
  ok(
    `${c.id}: reason is not a useless literal`,
    !c.useless.test(reason),
    JSON.stringify(reason).slice(0, 120),
  )
  ok(
    `${c.id}: reason explains itself`,
    done || reason.trim().length >= 12,
    JSON.stringify(reason).slice(0, 120),
  )
  // Soft: a fold that died with no artifact should still name the ceiling. It is
  // a warning rather than a failure because the ceiling is the tool's business
  // (pp-longchain-e2e.mts asserts it where the tool text is observable) while
  // this probe owns what the user sees.
  if (!done && figs === 0 && !c.want.test(reason))
    console.log(`  ~  ${c.id}: reason does not name the ceiling: ${JSON.stringify(reason).slice(0, 140)}`)

  // Opening it must not be a dead end either.
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
  ok(`${c.id}: detail badge agrees with the row`, (badge.trim() === '已完成') === done, badge)
  if (!done) {
    ok(
      `${c.id}: task page shows an error banner`,
      banner.trim().length > 0,
      banner.replace(/\s+/g, ' ').slice(0, 120),
    )
    ok(
      `${c.id}: task page banner is not a useless literal`,
      !c.useless.test(banner),
      banner.replace(/\s+/g, ' ').slice(0, 120),
    )
    // A failed row must be retryable and deletable, not stuck.
    ok(`${c.id}: offers a retry`, (await page.locator('text=重新提交此任务').count()) > 0)
  }
  await page.screenshot({ path: `/tmp/pp-longchain-ui-${c.id}.png`, fullPage: false })
}

await browser.close()
console.log(fail.length === 0 ? 'long-chain UI probe: PASS' : `long-chain UI probe: ${fail.length} FAILURES`)
process.exit(fail.length === 0 ? 0 : 1)
