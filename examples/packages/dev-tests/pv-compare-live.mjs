// Live regression: compare-card drag-select segment focus (round 55). Opens a
// historical compare session, drags the divergence strip with REAL mouse
// events, and checks the 聚焦区段 chip commits and clears. Titles rotate —
// accept any compare-bearing session (same candidates as pv-dark-live).
// With --shots, also writes the drag-focus gallery screenshot.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const SHOTS = process.argv.includes('--shots')
const OUT = new URL('../docs/screenshots/', import.meta.url).pathname

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
  for (const re of [/Compare p53/, /对比/, /compare/, /AlphaFold/]) {
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
    if (await page.evaluate(() => document.querySelectorAll('.pv-compare-bars').length > 0)) {
      opened = true
      break
    }
  }
  if (!opened) throw new Error('no compare-card session found in sidebar')

  // Real mouse drag across the divergence strip tiles (index 5 → 12).
  const tiles = page.locator('.pv-root:has(.pv-compare-bars) .pv-seq-tile')
  const n = await tiles.count()
  ok(`divergence strip mounted (tiles: ${n})`, n > 12)
  const from = await tiles.nth(5).boundingBox()
  const to = await tiles.nth(12).boundingBox()
  if (!from || !to) throw new Error('strip tiles have no bounding boxes')
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  for (let i = 6; i <= 12; i++) {
    const b = await tiles.nth(i).boundingBox()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
  }
  await page.mouse.up()
  await page.waitForTimeout(1200)

  const chip = page.locator('.pv-root:has(.pv-compare-bars) .pv-fmt--clear').first()
  ok(
    `drag commits 聚焦区段 chip (got "${await chip.textContent().catch(() => null)}")`,
    (await chip.count()) > 0 && (await chip.textContent()).includes('聚焦区段'),
  )
  ok(
    'compare 3D canvas present alongside the focus',
    (await page.locator('.pv-root:has(.pv-compare-bars) canvas.pv-3d').count()) > 0,
  )

  await chip.click()
  await page.waitForTimeout(800)
  ok(
    'chip click clears the focus',
    (await page.locator('.pv-root:has(.pv-compare-bars) .pv-fmt--clear').count()) === 0,
  )

  if (SHOTS) {
    // Gallery shot: re-focus a mid-chain segment so the 3D fade reads clearly
    // (6–13 sits at the N-term edge and is easy to miss at gallery size).
    const mid = page.locator('.pv-root:has(.pv-compare-bars) .pv-seq-tile')
    // Rows below the fold need scrolling — tiles out of the viewport never
    // receive real mouse events.
    const boxOf = async (i) => {
      const t = mid.nth(i)
      await t.scrollIntoViewIfNeeded().catch(() => {})
      return t.boundingBox()
    }
    const a = await boxOf(150)
    if (a) {
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2)
      await page.mouse.down()
      // Move through EVERY tile — a straight line across wrapped strip rows
      // skips tiles and the mouseover-driven drag never commits.
      for (let i = 151; i <= 190; i++) {
        const t = await boxOf(i)
        if (!t) continue
        await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2)
      }
      await page.mouse.up()
      await page.waitForTimeout(1200)
      const root = page.locator('.pv-root:has(.pv-compare-bars)').first()
      const box = await root.boundingBox()
      if (box) {
        await page.screenshot({
          path: `${OUT}/compare-seg-focus.png`,
          clip: {
            x: Math.max(0, box.x - 10),
            y: Math.max(0, box.y - 10),
            width: Math.min(1280, box.width + 20),
            height: Math.min(2400, box.height + 20),
          },
        })
        console.log('shot compare-seg-focus')
      }
      await page
        .locator('.pv-root:has(.pv-compare-bars) .pv-fmt--clear')
        .first()
        .click()
        .catch(() => {})
    }
  }
} catch (e) {
  console.log('FAIL', e?.message ?? e)
  failed++
}
await browser.close()
console.log(failed ? 'COMPARE LIVE FAIL' : 'COMPARE LIVE OK')
process.exit(failed ? 1 : 0)
