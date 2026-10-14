// Guest gate probe: locks the round-18 permission contract for non-owner users
// behind the form-login gate (Caddy forward_auth → /login/check).
//   node pp-guest-gate.mjs            # local (no header → owner mode, gate inert)
//   PP_BASE=… PP_USER=guest PP_PASS=… node pp-guest-gate.mjs   # remote guest
// Asserts: whoami.role/canSubmit (guest may SUBMIT), no delete affordances on
// the tasks page, and DELETE api/archive/<id> still 403s server-side. Also
// exercises the login page itself (loginViaUi) once per run.
// Requires at least one archive row to exist (the wall/tasks page is seeded by
// the other smokes; on a fresh deploy run pp-search-smoke first).
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { login, loginViaUi } from './pp-login.mjs'

const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const httpCreds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const origin = new URL(base).origin
const fail = []
const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
  headless: true,
})
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
if (httpCreds) await login(page.request, base, httpCreds)

// 0. Gated endpoint without a session must bounce to /login (the gate is
//    live). A FRESH context — the main page's request jar already holds the
//    session cookie after login(), so it cannot represent "anonymous".
const anonCtx = await browser.newContext()
const anon = await anonCtx.request.get(`${base}api/whoami`, { maxRedirects: 0 }).catch(() => null)
await anonCtx.close()
if (httpCreds && anon && anon.status() !== 302)
  fail.push(`anonymous whoami not gated (HTTP ${anon.status()})`)

// 1. Identity: guest reads as role=guest + canSubmit (submission is open to
//    every role now); local dev (no creds) as owner.
const who = await page.request.get(`${base}api/whoami`).then((r) => r.json())
if (httpCreds && who.user !== process.env.PP_USER) fail.push(`whoami.user=${who.user}`)
if (httpCreds && who.role !== 'guest') fail.push(`guest role=${who.role}`)
if (httpCreds && who.canSubmit !== true) fail.push(`guest canSubmit=${who.canSubmit}`)
if (httpCreds && who.readOnly !== true) fail.push(`guest readOnly=${who.readOnly}`)
if (!httpCreds && who.readOnly !== false) fail.push(`local readOnly=${who.readOnly}`)

// 2. Server-side gate: DELETE is 403 for a guest (and the probe uses a
//    nonexistent id — a 404 here would mean the gate never ran).
const del = await page.request.delete(`${base}api/archive/zz-nonexistent-gate-probe`, { headers: { origin } })
if (httpCreds && del.status() !== 403) fail.push(`guest DELETE status=${del.status()}`)
// Local owner may DELETE: any non-403 (deleteArchive is idempotent → 200 even
// for a missing id) proves the gate let the owner through.
if (!httpCreds && del.status() === 403) fail.push('owner DELETE blocked by gate (overblocking)')

// 3. UI affordance: tasks page shows no delete buttons for non-owner users.
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-composer', { timeout: 15000 })
await page.goto(`${base}#/tasks`, { timeout: 15000 })
// The history fetch is async — a bare .pl-empty here is the transient loading
// state, not a real empty page. Wait until rows render or the state settles.
await page.waitForSelector('.pl-tasklist a.pl-taskrow', { timeout: 10000 }).catch(async () => {
  await page
    .waitForFunction(
      () => {
        const e = document.querySelector('.pl-empty')
        return e && !/正在加载/.test(e.textContent ?? '')
      },
      { timeout: 10000 },
    )
    .catch(() => fail.push('tasks page never settled'))
})
const rows = await page.locator('.pl-tasklist a.pl-taskrow').count()
const delBtns = await page.locator('.pl-row-del').count()
if (httpCreds && rows > 0 && delBtns > 0) fail.push(`guest sees ${delBtns} delete buttons`)
if (!httpCreds && rows > 0 && delBtns === 0) fail.push('owner sees no delete buttons')

// 4. Login page itself: a fresh context walks the real form (fill → submit →
//    redirect back), proving the pretty page actually admits a valid user.
if (httpCreds) {
  const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
  const p2 = await ctx2.newPage()
  await loginViaUi(p2, base, httpCreds).catch(() => fail.push('loginViaUi failed'))
  const who2 = await p2.request
    .get(`${base}api/whoami`)
    .then((r) => r.json())
    .catch(() => null)
  if (who2?.user !== process.env.PP_USER) fail.push(`ui-login whoami.user=${JSON.stringify(who2)}`)
  await ctx2.close()
}

console.log(`whoami=${JSON.stringify(who)} rows=${rows} delBtns=${delBtns} DELETE=${del.status()}`)

await browser.close()
if (fail.length) {
  console.log('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('guest gate probe: PASS')
