// Live regression: PAE heatmap keyboard navigation (round 56). Opens a
// historical complex-panel session, focuses the heatmap canvas with REAL
// keyboard events, and checks the arrow-key cursor moves the readout and
// Esc clears it. Titles rotate — accept any session that mounts a PAE
// heatmap (complex/Boltz panels carry paePath).
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

  let opened = false
  for (const re of [/复合物/, /Boltz/, /两条链/, /配体/, /complex/i]) {
    await page.evaluate((src) => {
      const el = [...document.querySelectorAll('.session-title, li, [role=button], span')].find(
        (e) => e.childElementCount === 0 && new RegExp(src).test((e.textContent ?? '').trim()),
      )
      const hit = el?.closest('li, [role=button], button, div')
      hit?.click()
      el?.click()
    }, re.source)
    await page.waitForTimeout(6000)
    await page.evaluate(() => {
      document.querySelectorAll('details.turn-process:not([open]) summary').forEach((s) => {
        s.click()
      })
    })
    await page.waitForTimeout(2000)
    if (await page.evaluate(() => !!document.querySelector('canvas.pv-pae-canvas'))) {
      opened = true
      break
    }
  }
  if (!opened) throw new Error('no PAE-bearing complex session found in sidebar')

  const readout = () =>
    page.evaluate(() => document.querySelector('.pv-pae-side .pv-hoverline')?.textContent ?? '')

  // Focus the heatmap canvas and drive the cursor with real keys.
  await page.evaluate(() => document.querySelector('canvas.pv-pae-canvas').focus())
  await page.waitForTimeout(400)
  const start = await readout()
  ok(`focus starts the cursor readout (got "${start}")`, start.includes('·'))

  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(400)
  const afterRight = await readout()
  ok(
    `ArrowRight moves the readout (${start} → ${afterRight})`,
    afterRight !== start && afterRight.includes('·'),
  )

  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(400)
  const afterDown = await readout()
  ok(`ArrowDown moves the readout (→ ${afterDown})`, afterDown !== afterRight)

  await page.keyboard.press('End')
  await page.waitForTimeout(400)
  const afterEnd = await readout()
  ok(`End jumps columns (→ ${afterEnd})`, afterEnd !== afterDown)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  // Esc blurs the canvas: the cursor clears and the canvas loses focus-visible.
  const blurred = await page.evaluate(
    () => document.activeElement !== document.querySelector('canvas.pv-pae-canvas'),
  )
  ok('Escape blurs the heatmap canvas', blurred)
} catch (e) {
  console.log('FAIL', e?.message ?? e)
  failed++
}
await browser.close()
console.log(failed ? 'PAE KBD LIVE FAIL' : 'PAE KBD LIVE OK')
process.exit(failed ? 1 : 0)
