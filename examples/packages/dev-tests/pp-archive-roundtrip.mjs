// Archive roundtrip probe (self-contained): submit P69905 → done → archived=true →
// fresh context (no localStorage) renders the result page from the surface archive.
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

// --- Pass 1: submit + wait done + archived flag.
const ctx1 = await browser.newContext({ viewport: { width: 1400, height: 1000 }, ...(httpCreds ? { httpCredentials: httpCreds } : {}) })
if (httpCreds) await login(ctx1.request, base, httpCreds)
const p1 = await ctx1.newPage()
await p1.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
await p1.waitForSelector('.pl-composer textarea', { timeout: 15000 })
await p1.fill('.pl-composer textarea', 'P69905')
await p1.fill('.pl-input-name', '归档往返探针')
await p1.click('.pl-submit')
await p1.goto(`${base}#/tasks`, { timeout: 15000 })
const outcome = await p1
  .waitForSelector('.pl-tasklist a.pl-taskrow:first-child .pl-badge.done, .pl-tasklist a.pl-taskrow:first-child .pl-badge.failed, .pl-tasklist a.pl-taskrow:first-child .pl-badge.cancelled', {
    timeout: 420000,
    state: 'attached',
  })
  .then((el) => el.textContent())
  .catch(() => null)
if (outcome !== '已完成') fail.push(`task outcome: ${outcome}`)

// archive write is async after turn/end — poll localStorage for archived=true.
let taskId = null
let archived = false
for (let i = 0; i < 15; i++) {
  const store = await p1.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]'))
  taskId = store[0]?.id
  archived = !!store[0]?.archived
  if (archived) break
  await new Promise((r) => setTimeout(r, 2000))
}
console.log(`taskId=${taskId} outcome=${outcome} archived=${archived}`)
if (!archived) fail.push('task not archived within 30s of completion')
await ctx1.close()

// --- Pass 2: fresh context, empty localStorage → archive-backed result page.
const ctx2 = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  deviceScaleFactor: 2,
  ...(httpCreds ? { httpCredentials: httpCreds } : {}),
})
if (httpCreds) await login(ctx2.request, base, httpCreds)
const p2 = await ctx2.newPage()
p2.on('console', (m) => {
  if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 160))
})
await p2.goto(`${base}#/task/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await p2.waitForSelector('.pv-root canvas', { timeout: 60000 }).catch(() => fail.push('no .pv-root canvas from archive'))
const canvasBox = await p2.locator('.pv-root canvas').first().boundingBox().catch(() => null)
if (!canvasBox || canvasBox.width < 300) fail.push(`canvas too small: ${JSON.stringify(canvasBox)}`)
const body = await p2.textContent('.pl-result').catch(() => '')
if (!/历史归档|已完成/.test(body ?? '')) fail.push(`archived head missing: ${(body ?? '').slice(0, 120)}`)
await p2.screenshot({ path: '/tmp/pp-archive-result.png' })
// Archived compare entry: a UniProt-sourced archive must offer the AlphaFold-DB
// compare flow without the original live task — click it and require a fresh
// compare task to appear in THIS context's store (full compare chain is covered
// by pp-compare-smoke).
const cmpBtn = p2.locator('button.pl-back', { hasText: 'AlphaFold' }).first()
await cmpBtn
  .waitFor({ timeout: 15000, state: 'visible' })
  .then(() => cmpBtn.click())
  .catch(() => fail.push('archived compare button missing'))
await p2
  .waitForFunction(
    () => {
      const t = JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')
      return t[0]?.type === 'compare' && t[0]?.status === 'running'
    },
    { timeout: 30000 },
  )
  .catch(() => fail.push('archived compare click did not start a compare task'))
await ctx2.close()

// --- Pass 3: archive API direct (context-bound request so remote basic-auth rides along).
const api = (await browser.newContext({ ...(httpCreds ? { httpCredentials: httpCreds } : {}) })).request
if (httpCreds) await login(api, base, httpCreds)
const get = async (p) =>
  api
    .get(new URL(p, base).href)
    .then((r) => r.json().catch(() => null))
    .catch(() => null)
const meta = await get(`api/archive/${taskId}/meta`)
console.log('archive meta:', JSON.stringify(meta))
if (!meta?.reportPath?.endsWith('.json')) fail.push(`meta.reportPath: ${meta?.reportPath}`)
if (meta?.accession !== 'P69905') fail.push(`meta.accession: ${meta?.accession}`)
const rep = await get(`api/archive/${taskId}/report`)
if (typeof rep?.output?.meanPlddt !== 'number') fail.push(`report meanPlddt: ${rep?.output?.meanPlddt}`)
else console.log('archived meanPlddt:', rep.output.meanPlddt)
const st = await get(`api/archive/${taskId}/structure`)
const nRes = st?.output?.residues?.length ?? 0
if (nRes < 10) fail.push(`structure residues: ${nRes}`)
else console.log('archived structure residues:', nRes)

if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  await browser.close()
  process.exit(1)
}
console.log('archive roundtrip: PASS')
await browser.close()
