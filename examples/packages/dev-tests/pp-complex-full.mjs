// Complex full E2E: submit two chains → done → resultJson panel renders →
// archived → fresh context renders from archive (incl. /pae endpoint).
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
// PP_BASE lets the probe drive a remote deployment (e.g. the public platform);
// PP_USER/PP_PASS supply its basic-auth credentials (read via ssh, never logged).
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const httpCreds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })

const newCtx = () =>
  browser.newContext({ viewport: { width: 1400, height: 1000 }, ...(httpCreds ? { httpCredentials: httpCreds } : {}) })

// Pass 1: run the task.
const ctx1 = await newCtx()
const p1 = await ctx1.newPage()
p1.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}]`, m.text().slice(0, 200))
})
await p1.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
await p1.waitForSelector('.pl-composer textarea', { timeout: 15000 })
await p1.click('.pl-type-tab:has-text("复合物预测")')
await p1.fill('.pl-composer textarea', 'MVLSPADKTNVKAAWGKVGAHAGEYGAEAL\nVHLTPEEKSAVTALWGKVNVDEVGGEALGR')
await p1.click('.pl-submit')
await p1.goto(`${base}#/tasks`, { timeout: 15000 })
const outcome = await p1
  .waitForSelector('.pl-tasklist a.pl-taskrow:first-child .pl-badge.done, .pl-tasklist a.pl-taskrow:first-child .pl-badge.failed', { timeout: 900000, state: 'attached' })
  .then((el) => el.textContent())
  .catch(() => null)
if (outcome !== '已完成') fail.push(`complex outcome: ${outcome}`)
const t = (await p1.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')))[0]
console.log('task:', JSON.stringify({ id: t?.id, status: t?.status, resultJson: !!t?.resultJson, archived: t?.archived, error: t?.error }))
if (!t?.resultJson) fail.push('resultJson not captured')
// Panel renders from the inline JSON — wait for the 3D canvas.
await p1.click('a.pl-taskrow')
await p1.waitForSelector('.pl-result', { timeout: 15000 })
await p1.waitForSelector('.pv-root canvas', { timeout: 90000 }).catch(() => fail.push('no canvas on live complex result'))
// Archived flag appears after the async archive write.
await p1.waitForFunction(
  () => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')[0]?.archived === true,
  { timeout: 60000 },
).then(() => console.log('archived: true')).catch(() => fail.push('complex not archived within 60s'))
const taskId = t?.id
await ctx1.close()

// Pass 2: fresh context → archive-backed complex result (canvas + PAE endpoint).
if (taskId) {
  const ctx2 = await newCtx()
  const p2 = await ctx2.newPage()
  await p2.goto(`${base}#/task/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await p2.waitForSelector('.pv-root canvas', { timeout: 90000 }).catch(() => fail.push('no canvas from complex archive'))
  const pae = await fetch(new URL(`api/archive/${taskId}/pae`, base), {
    headers: httpCreds ? { authorization: 'Basic ' + Buffer.from(`${httpCreds.username}:${httpCreds.password}`).toString('base64') } : {},
  }).then((r) => r.json()).catch(() => null)
  console.log('pae endpoint:', pae?.output ? `n=${pae.output.n ?? '?'}` : JSON.stringify(pae).slice(0, 80))
  await p2.screenshot({ path: '/tmp/pp-complex-archive.png' })
  await ctx2.close()
}
await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('complex full E2E: PASS')
