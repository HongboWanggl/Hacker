// Batch share-report probe: open an archived batch task, click ⇩ 分享报告, and
// require the interactive viewer to carry a tab per target job (plus a rendered
// canvas). Complements pp-share-report.mjs (single/complex archived) and
// pp-share-live.mjs (live branch).
//   node pp-share-batch.mjs
import { readFileSync, writeFileSync } from 'node:fs'
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
  const taskId = await page.evaluate(async () => {
    const base = location.href.split('#')[0]
    const list = await (await fetch(new URL('api/archive', base.endsWith('/') ? base : `${base}/`))).json()
    // Prefer a batch archive with ≥2 ok jobs so the tab bar is really exercised.
    for (const m of list.filter((x) => x.type === 'batch')) {
      const r = await (
        await fetch(new URL(`api/archive/${m.taskId}/report`, base.endsWith('/') ? base : `${base}/`))
      )
        .json()
        .catch(() => null)
      const jobs = (r?.output ?? r)?.jobs ?? []
      if (jobs.filter((j) => j.status === 'ok').length >= 2) return m.taskId
    }
    return null
  })
  if (!taskId) {
    console.error('FAIL: no batch archive with ≥2 ok jobs found to share')
    process.exit(1)
  }
  console.log('sharing batch archive:', taskId)
  await page.goto(`${base}#/task/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.pv-root', { timeout: 60000 })
  await page.waitForTimeout(1500)
  const download = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    page.click('button.pl-back:has-text("分享报告")'),
  ]).then(([d]) => d)
  const html = readFileSync(await download.path(), 'utf8')
  const payload = html.match(/<script id="pv-data" type="application\/json">([\s\S]*?)<\/script>/)?.[1]
  const sets = payload ? JSON.parse(payload).sets : []
  const checks = [
    ['interactive 3D viewer', /id="pv3d"/.test(html)],
    ['per-target sets embedded', sets.length >= 2],
    ['set names are accessions', sets.every((s) => typeof s.name === 'string' && s.name.length > 0)],
    ['set residues present', sets.every((s) => (s.residues?.length ?? 0) > 0)],
  ]
  for (const [k, ok] of checks)
    console.log(`${k}: ${ok ? 'ok' : `FAIL (${k.includes('sets') ? sets.length : ''})`}`)
  if (checks.some(([, ok]) => !ok)) fail.push('batch share report missing viewer tabs/payload')
  // Open the report and assert the tab bar switches targets (canvas changes).
  if (!fail.length) {
    writeFileSync('/tmp/pp-share-batch-out.html', html)
    const rp = await ctx.newPage()
    await rp.goto('file:///tmp/pp-share-batch-out.html', { waitUntil: 'load' })
    await rp.waitForTimeout(700)
    const tabCount = await rp.locator('#pv-tabs button').count()
    const sig = () => rp.evaluate(() => document.getElementById('pv3d').toDataURL())
    const s0 = await sig()
    await rp.click(`#pv-tabs button >> nth=${Math.min(1, tabCount - 1)}`)
    const s1 = await sig()
    const tabText = await rp.locator('#pv-tabs button >> nth=1').textContent()
    console.log(
      `tab bar: ${tabCount} tabs · switch changes canvas: ${s1 !== s0 ? 'ok' : 'FAIL'} · tab label "${tabText}"`,
    )
    if (s1 === s0) fail.push('tab switch did not redraw canvas')
    if (tabCount < 2) fail.push('tab bar missing')
    await rp.close()
  }
} catch (e) {
  fail.push(e?.message ?? String(e))
} finally {
  await browser.close()
}
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('share batch: PASS')
