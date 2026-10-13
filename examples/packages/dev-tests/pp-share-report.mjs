// Share-report smoke: open an archived single task, click ⇩ 分享报告, capture
// the downloaded HTML, and require a real self-contained report (inline PNG
// snapshot + hero score + embedded report JSON). Uses whatever archive exists
// — no new prediction needed.

import { readFileSync, writeFileSync } from 'node:fs'
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
// PP_BASE/PP_USER/PP_PASS: drive a remote deployment (see pp-complex-full.mjs).
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const httpCreds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  acceptDownloads: true,
  ...(httpCreds ? { httpCredentials: httpCreds } : {}),
})
const page = await ctx.newPage()

// Pick the most recent single archive with a score (via the page itself so
// remote basic-auth applies).
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
const taskId = await page
  .evaluate(async () => {
    const base = location.href.split('#')[0]
    const list = await (await fetch(new URL('api/archive', base.endsWith('/') ? base : `${base}/`))).json()
    const m = list.find((x) => x.type === 'single' && typeof x.meanPlddt === 'number')
    return m?.taskId ?? null
  })
  .catch(() => null)
if (!taskId) {
  console.error('FAIL: no scored single archive found to share')
  process.exit(1)
}
console.log('sharing archive:', taskId)
await page.goto(`${base}#/task/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pv-root canvas', { timeout: 60000 })
// Give the WebGL frame a beat so the snapshot isn't blank.
await page.waitForTimeout(1500)

const download = await Promise.all([
  page.waitForEvent('download', { timeout: 30000 }),
  page.click('button.pl-back:has-text("分享报告")'),
]).then(([d]) => d)
const path = await download.path()
const html = readFileSync(path, 'utf8')
writeFileSync('/tmp/pp-share-out.html', html)
const checks = [
  ['inline PNG figure', /<img src="data:image\/png/.test(html)],
  ['hero pLDDT score', /平均 pLDDT/.test(html)],
  ['embedded report JSON', /完整报告数据/.test(html)],
  ['title header', /蛋白质结构预测报告/.test(html)],
  ['interactive 3D viewer', /id="pv3d"/.test(html)],
  ['viewer residue payload', /"residues":\[\{/.test(html)],
]
for (const [k, ok] of checks) console.log(`${k}: ${ok ? 'ok' : 'FAIL'}`)
if (checks.some(([, ok]) => !ok)) fail.push('share report HTML incomplete')
const sizeOk = html.length > 20_000
console.log(`report size: ${html.length} bytes ${sizeOk ? '(embeds real figures)' : '(suspiciously small)'}`)
if (!sizeOk) fail.push('report too small to contain figures')

// Open the downloaded report and verify the interactive viewer actually paints
// (non-blank canvas) and responds to drag + zoom (pixels change).
if (checks.every(([, ok]) => ok)) {
  const rp = await ctx.newPage()
  await rp.goto('file:///tmp/pp-share-out.html', { waitUntil: 'load' })
  await rp.waitForTimeout(900)
  const painted = await rp.evaluate(() => {
    const cv = document.getElementById('pv3d')
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
    let colored = 0
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 0 && (Math.abs(d[i] - d[i + 1]) > 12 || Math.abs(d[i + 1] - d[i + 2]) > 12)) colored++
    }
    return colored
  })
  console.log(`viewer painted pixels: ${painted} ${painted > 200 ? 'ok' : 'FAIL'}`)
  if (painted <= 200) fail.push('interactive viewer canvas blank')
  const spinOn = await rp.evaluate(() => document.getElementById('pv-spin').textContent.includes('暂停'))
  // Pause auto-rotate so each interaction is tested in isolation.
  await rp.click('#pv-spin')
  const sig = () => rp.evaluate(() => document.getElementById('pv3d').toDataURL())
  const s0 = await sig()
  await rp.mouse.move(700, 380)
  await rp.mouse.down()
  await rp.mouse.move(820, 300, { steps: 8 })
  await rp.mouse.up()
  const s1 = await sig()
  // Wheel must land ON the canvas — use its bounding box, not page coords
  // guessed from the drag (layout shifts move the canvas edge).
  const box = await rp.locator('#pv3d').boundingBox()
  await rp.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await rp.mouse.wheel(0, -240)
  await rp.waitForTimeout(300)
  const s2 = await sig()
  console.log(
    `drag rotates: ${s1 !== s0 ? 'ok' : 'FAIL'} · wheel zooms: ${s2 !== s1 ? 'ok' : 'FAIL'} · auto-rotate on: ${spinOn ? 'ok' : 'FAIL'}`,
  )
  if (s1 === s0) fail.push('viewer did not respond to drag')
  if (s2 === s1) fail.push('viewer did not respond to wheel zoom')
  if (!spinOn) fail.push('auto-rotate not enabled by default')
  await rp.close()
}
await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('share report: PASS')
