// Live regression: batch drill-down parity (round 52). Opens a historical
// batch_predict session, expands the first row with a REAL click, and checks
// the drill-down exposes the shared color dropdown + jump box; switching to
// rainbow swaps the legend. Titles rotate — accept any table-bearing session.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`

const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 1500 } })
let failed = 0
const ok = (name, cond) => {
  console.log(cond ? 'ok ' : 'FAIL', name)
  if (!cond) failed++
}
try {
  await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(5000)
  try {
    await page
      .getByRole('button', { name: /close|关闭/i })
      .first()
      .click({ timeout: 3000 })
  } catch {}
  await page.evaluate(() =>
    document.querySelectorAll('.workspace-heading').forEach((h) => {
      if (h.getAttribute('aria-expanded') === 'false' || !h.nextElementSibling?.offsetParent) h.click()
    }),
  )
  await page.waitForTimeout(1000)

  const candidates = ['batch_predict|批处理|一次预测|多个蛋白']
  let opened = false
  for (const re of candidates) {
    await page.evaluate((src) => {
      const el = [...document.querySelectorAll('.session-title, li, [role=button], span')].find(
        (e) => e.childElementCount === 0 && new RegExp(src).test((e.textContent ?? '').trim()),
      )
      const hit = el?.closest('li, [role=button], button, div')
      hit?.click()
      el?.click()
    }, re)
    await page.waitForTimeout(6000)
    await page.evaluate(() => {
      document.querySelectorAll('details.turn-process:not([open]) summary').forEach((s) => {
        s.click()
      })
    })
    await page.waitForTimeout(2000)
    if (await page.evaluate(() => document.querySelectorAll('.pv-batch-row--ok').length > 0)) {
      opened = true
      break
    }
  }
  if (!opened) throw new Error('no batch-table session found in sidebar')

  // Expand the first row with a real click → drill-down mounts.
  await page.locator('.pv-batch-row--ok').first().click()
  await page.waitForTimeout(4000)
  const detail = page.locator('.pv-batch-detail').first()
  ok('drill-down mounted', (await detail.count()) > 0)
  ok(
    'drill-down exposes its own 3D canvas',
    (await page.locator('.pv-batch-detail canvas.pv-3d').count()) > 0,
  )

  const sel = page.locator('.pv-batch-detail .pv-select').first()
  ok('drill-down exposes the color dropdown', (await sel.count()) > 0)
  const legendBefore = await page.locator('.pv-batch-detail .pv-legend-note').first().textContent()
  await sel.selectOption('rainbow')
  await page.waitForTimeout(800)
  const legendAfter = await page.locator('.pv-batch-detail .pv-legend-note').first().textContent()
  ok(
    `rainbow legend appears after switch (${legendBefore?.trim()} → ${legendAfter?.trim()})`,
    (legendAfter ?? '').includes('N→C'),
  )

  const jump = page.locator('.pv-batch-detail .pv-jump').first()
  ok('drill-down exposes the jump box', (await jump.count()) > 0)
  await jump.fill('3-6')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  const fmt = await page.locator('.pv-batch-detail .pv-fmt').first().textContent()
  ok(`jump range focuses the segment in the drill-down (got "${fmt}")`, (fmt ?? '').includes('聚焦区段'))
} catch (e) {
  console.log('FAIL', e?.message ?? e)
  failed++
}
await browser.close()
console.log(failed ? 'DRILL LIVE FAIL' : 'DRILL LIVE OK')
process.exit(failed ? 1 : 0)
