// Live E2E: the jump box accepts residue RANGES ("36-42", "B:1-5") and drives
// the segment focus — the 聚焦区段 label appears, curve + 3D highlight, and
// re-entering the same range clears it. Opens a historical main-panel session
// (titles rotate; accept the first with ≥100 tiles + a jump box).
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
try {
  await page
    .getByRole('button', { name: /close|关闭/i })
    .first()
    .click({ timeout: 3000 })
} catch {}

const candidates = [
  /预测指定序列蛋白结构与置信度/,
  /蛋白结构预测与置信度总结/,
  /预测蛋白结构并总结置信度/,
  /预测P61626/,
  /P61626/,
  /p53蛋白/,
  /预测蛋白质/,
]
let opened = false
for (const rx of candidates) {
  try {
    await page.getByText(rx).first().click({ timeout: 4000 })
  } catch {
    continue
  }
  await page.waitForTimeout(9000)
  await page.evaluate(() =>
    document.querySelectorAll('details.turn-process:not([open]) summary').forEach((s) => {
      s.click()
    }),
  )
  await page.waitForTimeout(2500)
  const ok = await page.evaluate(
    () => !!document.querySelector('.pv-jump') && document.querySelectorAll('.pv-seq-tile').length >= 100,
  )
  if (ok) {
    opened = true
    console.log('session matched:', rx)
    break
  }
}
if (!opened) {
  console.log('FAIL no session with jump box + long panel')
  process.exit(1)
}

let failed = 0
const check = (cond, name) => {
  console.log(cond ? 'ok ' : 'FAIL', name)
  if (!cond) failed++
}

// Type a range and press Enter in the real input.
async function jumpRange(v) {
  await page.locator('.pv-jump').first().fill(v)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(800)
  return page.evaluate(() => document.querySelector('.pv-fmt')?.textContent ?? '')
}

const label = await jumpRange('10-30')
check(label.includes('聚焦区段 10–30'), `range 10-30 focuses the segment (got "${label}")`)

const label2 = await jumpRange('10-30')
check(label2 === '', `re-entering the range clears it (got "${label2}")`)

const label3 = await jumpRange('9999-20000')
check(label3 === '', `out-of-range refused (got "${label3}")`)

// A residue jump still works alongside: hoverline updates.
await page.locator('.pv-jump').first().fill('20')
await page.keyboard.press('Enter')
await page.waitForTimeout(600)
const line = await page.evaluate(() => document.querySelector('.pv-hoverline')?.textContent ?? '')
check(line.length > 0, `single-residue jump still highlights (${line.slice(0, 40)})`)

await browser.close()
console.log(failed ? 'RANGE LIVE FAIL' : 'RANGE LIVE OK')
process.exit(failed ? 1 : 0)
