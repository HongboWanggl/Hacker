// Live regression: panel dark-theme adaptation (round 41; behavior introduced
// in round 40). Forces the host's `.dark` class on <html>, asserts the panel's
// computed surfaces flip and restore, and (with --shots) writes dark-mode
// gallery screenshots into examples/packages/docs/screenshots/.
// Run against the live web UI on 127.0.0.1:4177:
//   node pv-dark-live.mjs           # assertions only
//   node pv-dark-live.mjs --shots   # + write dark gallery PNGs
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const SHOTS = process.argv.includes('--shots')
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`

const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 1500 }, deviceScaleFactor: 2 })
const fail = []
try {
  await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(5000)
  try {
    await page
      .getByRole('button', { name: /close|关闭/i })
      .first()
      .click({ timeout: 3000 })
  } catch {}
  // Workspace groups may render collapsed — expand all headings first (known probe trap).
  await page.evaluate(() =>
    document.querySelectorAll('.workspace-heading').forEach((h) => {
      if (h.getAttribute('aria-expanded') === 'false' || !h.nextElementSibling?.offsetParent) h.click()
    }),
  )
  await page.waitForTimeout(1000)

  // Sidebar spans can be "not visible" to Playwright — click via DOM dispatch.
  // Session titles rotate; match by content candidates, any confident-panel one works.
  async function openSession(titleRe) {
    return page.evaluate((re) => {
      const el = [...document.querySelectorAll('.session-title, li, [role=button], span')].find(
        (e) => e.childElementCount === 0 && new RegExp(re).test((e.textContent ?? '').trim()),
      )
      const hit = el?.closest('li, [role=button], button, div')
      if (!hit && !el) return false
      hit?.click()
      el?.click()
      return true
    }, titleRe.source)
  }
  async function expandTurns() {
    await page.waitForTimeout(6000)
    await page.evaluate(() => {
      document.querySelectorAll('details.turn-process:not([open]) summary').forEach((s) => {
        s.click()
      })
    })
    await page.waitForTimeout(2000)
  }

  const opened = await openSession(/预测蛋白结构并总结置信度|蛋白结构预测与置信度总结|p53蛋白/)
  if (!opened) throw new Error('no confidence-panel session found in sidebar')
  await expandTurns()

  const styles = () =>
    page.evaluate(() => {
      const pick = (sel, prop) => {
        const el = document.querySelector(sel)
        return el ? getComputedStyle(el)[prop] : null
      }
      return {
        rootImage: pick('.pv-root', 'backgroundImage'),
        rootText: pick('.pv-root', 'color'),
        selectBg: pick('.pv-select', 'backgroundColor'),
        exportColor: pick('.pv-export', 'color'),
        curveBg: pick('.pv-curve', 'backgroundColor'),
        darkOnHtml: document.documentElement.classList.contains('dark'),
      }
    })

  const light = await styles()
  if (light.darkOnHtml) throw new Error('unexpected: host already dark')
  if (!light.rootImage?.includes('250, 251, 254'))
    fail.push(`light root gradient unexpected: ${light.rootImage}`)

  await page.evaluate(() => document.documentElement.classList.add('dark'))
  await page.waitForTimeout(600)
  const dark = await styles()
  if (dark.rootImage?.includes('250, 251, 254') || dark.rootImage?.includes('242, 245, 250'))
    fail.push('root gradient still light under .dark')
  if (light.rootImage === dark.rootImage) fail.push('root gradient did not change')
  if (light.rootText === dark.rootText) fail.push('root text color did not change')
  if (dark.selectBg === 'rgb(255, 255, 255)') fail.push('select still white under .dark')
  if (dark.curveBg !== 'rgb(255, 255, 255)')
    fail.push('curve card no longer white (must stay a paper-figure card)')
  if (dark.exportColor === 'rgb(0, 83, 214)') fail.push('export button text still light-theme blue')

  async function shoot(sel, name) {
    const el = page.locator(sel).first()
    await el.scrollIntoViewIfNeeded().catch(() => {})
    await page.waitForTimeout(800)
    const box = await el.boundingBox().catch(() => null)
    if (!box) {
      fail.push(`no bounding box for ${name}`)
      return
    }
    await page.screenshot({
      path: `${OUT}/${name}.png`,
      clip: {
        x: Math.max(0, box.x - 10),
        y: Math.max(0, box.y - 10),
        width: Math.min(1280, box.width + 20),
        height: Math.min(1500, box.height + 20),
      },
    })
    console.log('shot', name)
  }

  if (SHOTS) await shoot('.pv-root', 'main-panel-dark')

  // Compare card: track surfaces must flip too.
  if (await openSession(/Compare p53|对比/)) {
    await expandTurns()
    const compareBar = await page.evaluate(() => {
      const el = document.querySelector('.pv-compare-bar')
      return el ? getComputedStyle(el).backgroundColor : null
    })
    if (!compareBar || compareBar === 'rgb(229, 233, 240)') fail.push(`compare bar not dark: ${compareBar}`)
    if (SHOTS) await shoot('.pv-root:has(.pv-compare-bars)', 'compare-panel-dark')
  } else {
    console.log('note: no compare session found — skipping compare assertions')
  }

  // Restore light regardless of outcome; the host must not stay forced dark.
  await page.evaluate(() => document.documentElement.classList.remove('dark'))
  await page.waitForTimeout(400)
  const restored = await styles()
  if (restored.rootImage !== light.rootImage) fail.push('light mode did not restore after removing .dark')
} catch (e) {
  console.log('DARK PROBE ERROR:', String(e).slice(0, 300))
  fail.push(String(e).slice(0, 120))
  await page.evaluate(() => document.documentElement.classList.remove('dark')).catch(() => {})
} finally {
  await browser.close()
}

if (fail.length) {
  console.log(`DARK-MODE PROBE FAIL:\n${fail.join('\n')}`)
  process.exit(1)
}
console.log('DARK-MODE PROBE PASSED')
