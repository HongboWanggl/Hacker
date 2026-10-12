// Live E2E: a >800-residue single chain through predict_complex (local Boltz)
// exercises the ONLY untested live path — the protein.pae service mean-pool
// (scale>1) with a real npz, and the panel's pooled display. MPS runtime for
// ~843 aa is ~15-20 min, so poll up to 26 minutes before failing.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const PROMPT =
  '用 uniprot_fetch 获取 P11217（人肌糖原磷酸化酶）的序列，然后用 predict_complex 预测它的结构，预测完成后展示 PAE 热图并总结置信度。'

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
  await page.getByText('protein-predictor').first().click()
  await page.waitForTimeout(2000)
  await page
    .getByRole('button', { name: /new session/i })
    .first()
    .click()
  await page.waitForTimeout(2000)
  const box = page.locator('textarea').first()
  await box.fill(PROMPT)
  await page.keyboard.press('Enter')
  console.log('submitted long-protein prompt; polling for the panel (843 aa on MPS, ~15-20 min)')

  let mounted = false
  for (let i = 0; i < 312; i++) {
    await page.waitForTimeout(5000)
    mounted = await page.evaluate(() => !!document.querySelector('canvas.pv-pae-canvas'))
    if (mounted) break
  }
  if (!mounted) throw new Error('PAE heatmap never mounted within 26 minutes')

  // Pooled display: the caption must announce the mean-pool (scale>1), and the
  // hover readout must speak in residue ranges.
  const caption = await page.evaluate(() => document.querySelector('.pv-pae-caption')?.textContent ?? '')
  ok(`caption announces mean-pooling (got "${caption.slice(0, 40)}…")`, caption.includes('每格'))

  const readout = () =>
    page.evaluate(() => document.querySelector('.pv-pae-side .pv-hoverline')?.textContent ?? '')
  const hbox = await page.locator('canvas.pv-pae-canvas').boundingBox()
  if (!hbox) throw new Error('heatmap canvas box unavailable')
  await page.mouse.move(hbox.x + hbox.width * 0.35, hbox.y + hbox.height * 0.45)
  await page.waitForTimeout(400)
  const r = await readout()
  ok(`hover readout speaks residue ranges (got "${r}")`, r.includes('–') && r.includes('·'))

  // Pin still works on the pooled matrix.
  await page.mouse.click(hbox.x + hbox.width * 0.35, hbox.y + hbox.height * 0.45)
  await page.waitForTimeout(400)
  const pinned = await readout()
  await page.mouse.move(5, 5)
  await page.waitForTimeout(400)
  ok('pin survives mouse-leave on the pooled matrix', (await readout()) === pinned)

  if (process.argv.includes('--shots')) {
    await page.locator('.pv-pae').first().screenshot({ path: 'long-protein-pae.png' })
    console.log('shot: long-protein-pae.png')
  }
} catch (e) {
  console.log('FAIL', e?.message ?? e)
  failed++
}
await browser.close()
console.log(failed ? 'LONG PROTEIN LIVE FAIL' : 'LONG PROTEIN LIVE OK')
process.exit(failed ? 1 : 0)
