// Capture curated panel screenshots from the historical session into
// examples/packages/docs/screenshots/ for the README gallery. Not part of
// run-all.sh — run manually: node pv-screenshots.mjs
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
const exe = '/Users/wanghanbao/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const OUT = '/Users/wanghanbao/agnes-harness/examples/packages/docs/screenshots'
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 2 })
await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
try { await page.getByRole('button', { name: /close|关闭/i }).first().click({ timeout: 3000 }) } catch {}
await page.getByText(/p53蛋白P04637|p53蛋白/).first().click({ timeout: 5000 })
await page.waitForTimeout(9000)
await page.evaluate(() => document.querySelectorAll('details.turn-process:not([open]) summary').forEach((s) => s.click()))
await page.waitForTimeout(2500)

async function shoot(selector, name, pad = 12) {
  // Hide host floating buttons that can overlap the panel.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('button')) {
      if (/new content/i.test(el.textContent ?? '')) el.style.display = 'none'
    }
  })
  const el = page.locator(selector).first()
  try {
    await el.scrollIntoViewIfNeeded()
    await page.waitForTimeout(1200)
    const box = await el.boundingBox()
    if (!box) throw new Error('no box')
    await page.screenshot({
      path: `${OUT}/${name}.png`,
      clip: {
        x: Math.max(0, box.x - pad),
        y: Math.max(0, box.y - pad),
        width: Math.min(1280, box.width + pad * 2),
        height: Math.min(1400, box.height + pad * 2),
      },
    })
    console.log('shot', name)
  } catch (e) {
    console.log('MISS', name, String(e).slice(0, 80))
    process.exitCode = 1
  }
}

await shoot('.pv-root:has(.pv-3d) .pv-grid', 'confidence-3d-curve')          // 3D + curve side by side
// (No complex-card shot: real Boltz reports need an API key, so no live session
// exists. `.pv-complex-metrics` also matches the confidence summary — unusable.)

// compare / batch cards live in sessions created by the live E2E suite —
// switch sessions by sidebar title. (Sidebar spans can be "not visible" to
// playwright, so click via DOM dispatch.)
async function openSession(titleRe) {
  await page.evaluate((re) => {
    const el = [...document.querySelectorAll('.session-title, li, [role=button], span')]
      .find((e) => e.childElementCount === 0 && new RegExp(re).test((e.textContent ?? '').trim()))
    el?.closest('li, [role=button], button, div')?.click()
    el?.click()
  }, titleRe.source)
  await page.waitForTimeout(6000)
  await page.evaluate(() => document.querySelectorAll('details.turn-process:not([open]) summary').forEach((s) => s.click()))
  await page.waitForTimeout(2000)
}

await openSession(/compare_alphafold 对比|compare_structures 对比/)
await shoot('.pv-root:has(.pv-compare-bars)', 'compare-card')
// Cα-deviation lens variant: same card with the distance lens active — the
// strip recolors by post-superposition Cα distance and so does the 3D ghost.
const distChip = page.locator('button:has-text("Cα 偏差"):visible').first()
if (await distChip.count()) {
  await distChip.click()
  await page.waitForTimeout(1200)
  await shoot('.pv-root:has(.pv-compare-bars)', 'compare-dist-lens')
}
await openSession(/batch_predict 预测/)
await shoot('.pv-root:has(.pv-batch)', 'batch-card')
await openSession(/uniprot_search|lysozyme|搜索/)
await shoot('.pv-root:has(.pv-search-table)', 'search-card')
await browser.close()
console.log('SCREENSHOTS DONE')
