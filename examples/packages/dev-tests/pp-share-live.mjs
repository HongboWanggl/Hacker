// Live share-report probe: submit a real single prediction, and while the task
// is still live (not archived) click ⇩ 分享报告 — exercises the structurePath
// residue fetch that feeds the report's interactive 3D viewer. Archived pages
// are covered by pp-share-report.mjs; this covers the live branch.
//   node pp-share-live.mjs
import { readFileSync } from 'node:fs'
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
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
try {
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.pl-composer textarea', { timeout: 15000 })
  await page.fill('.pl-composer textarea', 'P69905')
  await page.fill('.pl-input-name', '分享-实时探针')
  await page.click('.pl-submit')
  // Submitting stays on home; the new task surfaces as the FIRST wall card
  // (wall sorts 新任务在前). Grab its task link, drive the result page directly.
  await page.waitForSelector('a.pl-card', { timeout: 15000 })
  const href = await page.getAttribute('a.pl-card >> nth=0', 'href')
  if (!href) fail.push('wall card has no task link')
  await page.goto(`${base}${href}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  // The 分享报告 button only renders once the task stops running; failed tasks
  // get 重新提交 instead — timeout here means the prediction never completed.
  await page.waitForSelector('button.pl-back:has-text("分享报告")', { timeout: 300000 })
  await page.waitForSelector('.pv-root canvas', { timeout: 60000 })
  await page.waitForTimeout(1500)

  const download = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('button.pl-back:has-text("分享报告")'),
  ]).then(([d]) => d)
  const p = await download.path()
  const html = readFileSync(p, 'utf8')
  const checks = [
    ['interactive 3D viewer', /id="pv3d"/.test(html)],
    ['viewer residue payload', /"residues":\[\{/.test(html)],
    ['hero pLDDT score', /平均 pLDDT/.test(html)],
  ]
  for (const [k, ok] of checks) console.log(`${k}: ${ok ? 'ok' : 'FAIL'}`)
  if (checks.some(([, ok]) => !ok)) fail.push('live share report missing viewer pieces')
} catch (e) {
  fail.push(e?.message ?? String(e))
} finally {
  await browser.close()
}
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('share live: PASS')
