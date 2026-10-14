// Live check: PAE maximized mode doubles the heatmap and fits the viewport.
// Guards the side-profile width bound (max-content caption once starved it).
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
let failed = 0
const ok = (n, c, x = '') => {
  console.log(c ? 'ok ' : 'FAIL', n, x)
  if (!c) failed++
}
await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
const candidates = await page.evaluate(() =>
  [...document.querySelectorAll('.session-title')]
    .map((s) => s.textContent.trim())
    .filter((t) => /PAE|热图|复合物/i.test(t)),
)
for (const title of candidates) {
  await page.evaluate((t) => {
    const el = [...document.querySelectorAll('.session-title')].find((s) => s.textContent.trim() === t)
    el?.closest('li, [role=button], button, div')?.click()
    el?.click()
  }, title)
  await page.waitForTimeout(3500)
  await page.evaluate(() =>
    document.querySelectorAll('details.turn-process:not([open])').forEach((d) => {
      d.querySelector('summary')?.click()
    }),
  )
  await page.waitForTimeout(2000)
  if (await page.evaluate(() => !!document.querySelector('canvas.pv-pae-canvas'))) break
}
const before = await page.evaluate(
  () => document.querySelector('canvas.pv-pae-canvas').getBoundingClientRect().width,
)
await page.evaluate(() =>
  [...document.querySelectorAll('.pv-pae button')].find((b) => b.textContent.includes('全屏'))?.click(),
)
await page.waitForTimeout(800)
const maxState = await page.evaluate(() => {
  const root = document.querySelector('.pv-pae')
  const c = document.querySelector('canvas.pv-pae-canvas')
  const r = c.getBoundingClientRect()
  return {
    isMax: root.className.includes('pv-pae--max'),
    w: Math.round(r.width),
    h: Math.round(r.height),
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    fits: r.right <= window.innerWidth && r.bottom <= window.innerHeight,
  }
})
console.log('inline:', Math.round(before), '→ max:', maxState.w)
ok('maximized class applied', maxState.isMax)
ok(`canvas grew in max mode (${Math.round(before)} → ${maxState.w})`, maxState.w > before)
ok(
  'maximized canvas fits viewport',
  maxState.fits,
  JSON.stringify({ w: maxState.w, innerW: maxState.innerW }),
)
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
const after = await page.evaluate(() => ({
  isMax: document.querySelector('.pv-pae').className.includes('pv-pae--max'),
  w: Math.round(document.querySelector('canvas.pv-pae-canvas').getBoundingClientRect().width),
}))
ok('Esc exits max mode', !after.isMax && Math.round(before) === after.w, `back to ${after.w}`)
await browser.close()
console.log(failed ? 'PAE MAX FAIL' : 'PAE MAX OK')
process.exit(failed ? 1 : 0)
