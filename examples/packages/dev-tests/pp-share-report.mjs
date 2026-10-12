// Share-report smoke: open an archived single task, click ⇩ 分享报告, capture
// the downloaded HTML, and require a real self-contained report (inline PNG
// snapshot + hero score + embedded report JSON). Uses whatever archive exists
// — no new prediction needed.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { readFileSync, writeFileSync } from 'node:fs'

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

const download = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('button.pl-back:has-text("分享报告")')]).then(
  ([d]) => d,
)
const path = await download.path()
const html = readFileSync(path, 'utf8')
writeFileSync('/tmp/pp-share-out.html', html)
const checks = [
  ['inline PNG figure', /<img src="data:image\/png/.test(html)],
  ['hero pLDDT score', /平均 pLDDT/.test(html)],
  ['embedded report JSON', /完整报告数据/.test(html)],
  ['title header', /蛋白质结构预测报告/.test(html)],
]
for (const [k, ok] of checks) console.log(`${k}: ${ok ? 'ok' : 'FAIL'}`)
if (checks.some(([, ok]) => !ok)) fail.push('share report HTML incomplete')
const sizeOk = html.length > 20_000
console.log(`report size: ${html.length} bytes ${sizeOk ? '(embeds real figures)' : '(suspiciously small)'}`)
if (!sizeOk) fail.push('report too small to contain figures')
await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('share report: PASS')
