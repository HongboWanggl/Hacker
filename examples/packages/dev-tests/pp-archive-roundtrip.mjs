// Archive roundtrip probe (self-contained): submit P69905 → done → archived=true →
// fresh context (no localStorage) renders the result page from the surface archive.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const fail = []
const base = 'http://127.0.0.1:4177/platform/'

const browser = await chromium.launch({ executablePath: exe, headless: true })

// --- Pass 1: submit + wait done + archived flag.
const ctx1 = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
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
const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 2 })
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
await ctx2.close()
await browser.close()

// --- Pass 3: archive API direct.
const meta = await fetch(new URL(`api/archive/${taskId}/meta`, base)).then((r) => r.json()).catch(() => null)
console.log('archive meta:', JSON.stringify(meta))
if (!meta?.reportPath?.endsWith('.json')) fail.push(`meta.reportPath: ${meta?.reportPath}`)
const rep = await fetch(new URL(`api/archive/${taskId}/report`, base)).then((r) => r.json()).catch(() => null)
if (typeof rep?.output?.meanPlddt !== 'number') fail.push(`report meanPlddt: ${rep?.output?.meanPlddt}`)
else console.log('archived meanPlddt:', rep.output.meanPlddt)
const st = await fetch(new URL(`api/archive/${taskId}/structure`, base)).then((r) => r.json()).catch(() => null)
const nRes = st?.output?.residues?.length ?? 0
if (nRes < 10) fail.push(`structure residues: ${nRes}`)
else console.log('archived structure residues:', nRes)

if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('archive roundtrip: PASS')
