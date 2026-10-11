// Live E2E: the 自动旋转 checkbox follows the emulated OS reduced-motion
// setting in a real Chromium — unchecked under reducedMotion:'reduce',
// checked in a normal context. Opens a historical predict_structure session
// (candidates rotate as new probes run; accept the first with the toggle).
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const candidates = [
  /预测指定序列蛋白结构与置信度/,
  /蛋白结构预测与置信度总结/,
  /预测蛋白结构并总结置信度/,
  /p53蛋白/,
  /预测P61626/,
  /P61626/,
  /预测蛋白质/,
]

async function openPanel(reduced) {
  const browser = await chromium.launch({ executablePath: exe, headless: true })
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    ...(reduced ? { reducedMotion: 'reduce' } : {}),
  })
  await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(5000)
  try {
    await page
      .getByRole('button', { name: /close|关闭/i })
      .first()
      .click({ timeout: 3000 })
  } catch {
    /* no modal */
  }
  await page.evaluate(() => {
    document.querySelectorAll('details.turn-process:not([open]) summary').forEach((s) => {
      s.click()
    })
  })
  await page.waitForTimeout(1500)
  let checked = null
  for (const rx of candidates) {
    try {
      await page.getByText(rx).first().click({ timeout: 4000 })
    } catch {
      continue
    }
    await page.waitForTimeout(9000)
    const box = await page.evaluate(() => {
      const lbl = [...document.querySelectorAll('.pv-toggle')].find((l) =>
        (l.textContent ?? '').includes('自动旋转'),
      )
      const inp = lbl?.querySelector('input[type=checkbox]')
      return inp ? { checked: inp.checked } : null
    })
    if (box) {
      checked = box.checked
      break
    }
  }
  await browser.close()
  return checked
}

let failed = 0
const check = (cond, name) => {
  console.log(cond ? 'ok ' : 'FAIL', name)
  if (!cond) failed++
}

const reduced = await openPanel(true)
check(reduced === false, `reducedMotion:reduce → 自动旋转 defaults OFF (got ${reduced})`)
const normal = await openPanel(false)
check(normal === true, `normal context → 自动旋转 stays ON (got ${normal})`)

console.log(failed ? 'MOTION LIVE FAIL' : 'MOTION LIVE OK')
process.exit(failed ? 1 : 0)
