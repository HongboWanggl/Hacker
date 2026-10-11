// Capture curated panel screenshots from the historical session into
// examples/packages/docs/screenshots/ for the README gallery. Not part of
// run-all.sh — run manually: node pv-screenshots.mjs
//
// Session titles rotate as probes accumulate (the sidebar renders only the
// latest ~100), so every panel is found by trying title candidates in order
// and accepting the first session whose panel actually mounted.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 }, deviceScaleFactor: 2 })
await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
try {
  await page
    .getByRole('button', { name: /close|关闭/i })
    .first()
    .click({ timeout: 3000 })
} catch {}

// (Sidebar spans can be "not visible" to playwright → click via DOM dispatch,
// like the other live probes.)
async function openPanel(candidates, acceptSel, tilesMin = 0) {
  for (const rx of candidates) {
    await page.evaluate((re) => {
      const el = [...document.querySelectorAll('.session-title, li, [role=button], span')].find(
        (e) => e.childElementCount === 0 && new RegExp(re).test((e.textContent ?? '').trim()),
      )
      el?.closest('li, [role=button], button, div')?.click()
      el?.click()
    }, rx.source)
    await page.waitForTimeout(9000)
    await page.evaluate(() =>
      document.querySelectorAll('details.turn-process:not([open]) summary').forEach((s) => {
        s.click()
      }),
    )
    await page.waitForTimeout(2500)
    const ok = await page.evaluate(
      ({ sel, min }) => {
        const root = document.querySelector('.pv-root:has(' + sel + ')')
        return !!root && document.querySelectorAll('.pv-seq-tile').length >= min
      },
      { sel: acceptSel, min: tilesMin },
    )
    if (ok) {
      console.log('session matched:', rx, '→', acceptSel)
      return true
    }
  }
  console.log('NO SESSION matched for', acceptSel)
  process.exitCode = 1
  return false
}

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

// 3D + curve side by side — needs a long-protein main panel (≥100 tiles) so
// the shot shows the dense strip, not a 4-aa stub.
await openPanel(
  [
    /预测指定序列蛋白结构与置信度/,
    /蛋白结构预测与置信度总结/,
    /预测蛋白结构并总结置信度/,
    /p53蛋白P04637/,
    /p53蛋白/,
    /预测P61626/,
    /P61626/,
    /预测蛋白质/,
  ],
  '.pv-3d',
  100,
)
await shoot('.pv-root:has(.pv-3d) .pv-grid', 'confidence-3d-curve')
// (No complex-card shot: real Boltz reports need an API key, so no live session
// exists. `.pv-complex-metrics` also matches the confidence summary — unusable.)

await openPanel(
  [/compare_alphafold|对比p53|AlphaFold 对比|对比.*AlphaFold/, /compare_structures|对比两个|突变体/],
  '.pv-compare-bars',
)
await shoot('.pv-root:has(.pv-compare-bars)', 'compare-card')
// Cα-deviation lens variant: same card with the distance lens active — the
// strip recolors by post-superposition Cα distance and so does the 3D ghost.
const distChip = page.locator('button:has-text("Cα 偏差"):visible').first()
if (await distChip.count()) {
  await distChip.click()
  await page.waitForTimeout(1200)
  await shoot('.pv-root:has(.pv-compare-bars)', 'compare-dist-lens')
}
await openPanel([/batch_predict|批处理|一次预测|两个蛋白/], '.pv-batch')
await shoot('.pv-root:has(.pv-batch)', 'batch-card')
await openPanel([/uniprot_search|检索UniProt|UniProt.*搜索|lysozyme|溶菌酶|搜索/], '.pv-search-table')
await shoot('.pv-root:has(.pv-search-table)', 'search-card')
await browser.close()
console.log('SCREENSHOTS DONE')
