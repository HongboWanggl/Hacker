// Live regression: batch table keyboard navigation (round 44). Opens a
// historical batch_predict session, focuses the first expandable row, and
// drives it with REAL key events — Enter/Space toggle the drill-down,
// ArrowDown/Home/End rove focus. Rows are divs made keyboard-actuable with
// role=button + tabindex.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`

const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 1500 }, deviceScaleFactor: 2 })
const fail = []
const ok = (name, cond) => {
  console.log(cond ? 'ok ' : 'FAIL', name)
  if (!cond) fail.push(name)
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
  // Workspace groups may render collapsed — expand all headings first (known probe trap).
  await page.evaluate(() =>
    document.querySelectorAll('.workspace-heading').forEach((h) => {
      if (h.getAttribute('aria-expanded') === 'false' || !h.nextElementSibling?.offsetParent) h.click()
    }),
  )
  await page.waitForTimeout(1000)

  // Session titles rotate — batch candidates, any table-bearing one works.
  const candidates = ['batch_predict|批处理|一次预测|多个蛋白']
  let opened = false
  for (const re of candidates) {
    await page.evaluate((src) => {
      const el = [...document.querySelectorAll('.session-title, li, [role=button], span')].find(
        (e) => e.childElementCount === 0 && new RegExp(src).test((e.textContent ?? '').trim()),
      )
      const hit = el?.closest('li, [role=button], button, div')
      hit?.click()
      el?.click()
    }, re)
    await page.waitForTimeout(6000)
    await page.evaluate(() => {
      document.querySelectorAll('details.turn-process:not([open]) summary').forEach((s) => {
        s.click()
      })
    })
    await page.waitForTimeout(2000)
    if (await page.evaluate(() => document.querySelectorAll('.pv-batch-row--ok').length > 0)) {
      opened = true
      break
    }
  }
  if (!opened) throw new Error('no batch-table session found in sidebar')

  const row0 = page.locator('.pv-batch-row--ok').first()
  await row0.scrollIntoViewIfNeeded()
  const N = await page.evaluate(() => document.querySelectorAll('.pv-batch-row--ok').length)
  ok(`batch table mounted (${N} expandable rows)`, N > 0)

  const state = () =>
    page.evaluate(() => {
      const rows = [...document.querySelectorAll('.pv-batch-row--ok')]
      return {
        focused: rows.indexOf(document.activeElement),
        open: rows.findIndex((r) => r.classList.contains('pv-batch-row--open')),
        expanded: rows.map((r) => r.getAttribute('aria-expanded')),
      }
    })

  await page.evaluate(() => document.querySelector('.pv-batch-row--ok').focus())
  await page.waitForTimeout(200)
  let s = await state()
  ok('row focusable (role=button + tabindex)', s.focused === 0)

  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  s = await state()
  ok('Enter expands the drill-down', s.open === 0 && s.expanded[0] === 'true')

  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  s = await state()
  ok('Enter again collapses', s.open === -1 && s.expanded[0] === 'false')

  await page.keyboard.press(' ')
  await page.waitForTimeout(300)
  s = await state()
  ok('Space also toggles the drill-down', s.open === 0)

  await page.keyboard.press(' ')
  await page.waitForTimeout(300)
  s = await state()
  ok('Space again collapses', s.open === -1)

  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(200)
  s = await state()
  ok('ArrowDown roves row focus', N === 1 ? s.focused === 0 : s.focused === 1)

  if (fail.length) throw new Error(`${fail.length} failed`)
  console.log('KBD BATCH LIVE OK')
} catch (e) {
  console.log('KBD BATCH LIVE FAIL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
