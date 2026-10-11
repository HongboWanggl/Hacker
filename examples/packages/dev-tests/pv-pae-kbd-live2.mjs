// Live E2E: fresh predict_complex session → PAE heatmap keyboard navigation
// with real keys. Local Boltz engine takes minutes per target, so poll for
// the panel up to 20 minutes before asserting.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const PROMPT =
  '用 predict_complex 预测这两条链的复合物：MKTAYIAKQRQISFVKSHFSRQ 和 EIAKQGQVTMVIKKSMLEK，预测完成后展示 PAE 热图并总结界面置信度。'

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
  console.log('submitted predict_complex prompt; polling for the panel (local engine, minutes)')

  let mounted = false
  for (let i = 0; i < 240; i++) {
    await page.waitForTimeout(5000)
    mounted = await page.evaluate(() => !!document.querySelector('canvas.pv-pae-canvas'))
    if (mounted) break
  }
  if (!mounted) throw new Error('PAE heatmap never mounted within 20 minutes')

  const readout = () =>
    page.evaluate(() => document.querySelector('.pv-pae-side .pv-hoverline')?.textContent ?? '')
  await page.evaluate(() => document.querySelector('canvas.pv-pae-canvas').focus())
  await page.waitForTimeout(400)
  const start = await readout()
  ok(`focus starts the cursor readout (got "${start}")`, start.includes('·'))
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(400)
  const afterRight = await readout()
  ok(`ArrowRight moves the readout (→ ${afterRight})`, afterRight !== start && afterRight.includes('·'))
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(400)
  const afterDown = await readout()
  ok(`ArrowDown moves the readout (→ ${afterDown})`, afterDown !== afterRight)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  const blurred = await page.evaluate(
    () => document.activeElement !== document.querySelector('canvas.pv-pae-canvas'),
  )
  ok('Escape blurs the heatmap canvas', blurred)

  // Click-to-pin: a real click fixes the readout — it survives the mouse
  // leaving AND Esc-blur, and a second click (plus blur) releases it.
  const hbox = await page.locator('canvas.pv-pae-canvas').boundingBox()
  if (!hbox) throw new Error('heatmap canvas box unavailable')
  const cx = hbox.x + hbox.width * 0.4
  const cy = hbox.y + hbox.height * 0.6
  await page.mouse.click(cx, cy)
  await page.waitForTimeout(400)
  const pinned = await readout()
  ok(`click pins a pair readout (got "${pinned}")`, pinned.includes('→'))
  await page.mouse.move(5, 5)
  await page.waitForTimeout(400)
  ok('pinned readout survives mouse-leave', (await readout()) === pinned)
  await page.keyboard.press('Escape') // blur — the pin must still survive
  await page.waitForTimeout(400)
  ok('pinned readout survives Esc-blur', (await readout()) === pinned)
  await page.mouse.click(cx, cy) // second click releases; click refocuses
  await page.waitForTimeout(400)
  await page.keyboard.press('Escape') // blur clears the keyboard cursor
  await page.mouse.move(5, 5) // and the pointer must leave (hover would own the readout)
  await page.waitForTimeout(400)
  const released = await readout()
  ok(`release + blur + mouse-out returns the strip readout (got "${released}")`, released !== pinned)
} catch (e) {
  console.log('FAIL', e?.message ?? e)
  failed++
}
await browser.close()
console.log(failed ? 'PAE KBD LIVE2 FAIL' : 'PAE KBD LIVE2 OK')
process.exit(failed ? 1 : 0)
