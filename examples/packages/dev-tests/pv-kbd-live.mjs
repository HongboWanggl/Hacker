// Live regression: sequence strip keyboard navigation (round 42). Focuses the
// strip with a real browser focus, then drives it with REAL key events
// (Playwright keyboard → native keydown → React discrete-event flush) and
// asserts the roving cursor, selection, jump keys, and that ←/→ focused in the
// strip do NOT leak into the panel-root's residue stepping (the round-42
// stopPropagation fix — this exact conflict is what the offline suite caught).
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

  // Sidebar spans can be "not visible" to Playwright — click via DOM dispatch.
  // Session titles rotate; match by content candidates, any confidence-panel one works.
  await page.evaluate((re) => {
    const el = [...document.querySelectorAll('.session-title, li, [role=button], span')].find(
      (e) => e.childElementCount === 0 && new RegExp(re).test((e.textContent ?? '').trim()),
    )
    const hit = el?.closest('li, [role=button], button, div')
    hit?.click()
    el?.click()
  }, '预测蛋白结构并总结置信度|蛋白结构预测与置信度总结|p53蛋白')
  await page.waitForTimeout(6000)
  await page.evaluate(() => {
    document.querySelectorAll('details.turn-process:not([open]) summary').forEach((s) => {
      s.click()
    })
  })
  await page.waitForTimeout(2500)

  const hasStrip = await page.evaluate(() => !!document.querySelector('.pv-seqstrip'))
  if (!hasStrip) throw new Error('no .pv-seqstrip in the opened session panel')
  const strip = page.locator('.pv-seqstrip').first()
  await strip.scrollIntoViewIfNeeded()

  const N = await page.evaluate(() => document.querySelectorAll('.pv-seq-tile').length)
  ok(`strip mounted (${N} tiles)`, N > 0)

  const state = () =>
    page.evaluate(() => {
      const tiles = [...document.querySelectorAll('.pv-seq-tile')]
      return {
        hover: tiles.findIndex((t) => t.classList.contains('pv-seq-tile--hover')),
        sel: tiles.findIndex((t) => t.classList.contains('pv-seq-tile--sel')),
        focused: document.activeElement?.classList?.contains('pv-seqstrip') ?? false,
        ariaSel: tiles.findIndex((t) => t.getAttribute('aria-selected') === 'true'),
      }
    })

  // Focus the strip without clicking a tile (a click would select a residue).
  await page.evaluate((el) => el.focus(), await strip.elementHandle())
  await page.waitForTimeout(300)
  let s = await state()
  ok('real focus() starts cursor at first tile', s.hover === 0 && s.focused)

  // REAL keyboard events — the same discrete-event flush a human produces.
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)
  s = await state()
  ok('ArrowRight moves cursor to #2', s.hover === 1)
  ok('ArrowRight does not leak into panel selection', s.sel === -1)

  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(150)
  s = await state()
  ok('ArrowRight again → #3', s.hover === 2 && s.sel === -1)

  await page.keyboard.press('ArrowLeft')
  await page.waitForTimeout(150)
  s = await state()
  ok('ArrowLeft moves back', s.hover === 1)

  await page.keyboard.press('Enter')
  await page.waitForTimeout(150)
  s = await state()
  ok('Enter selects the cursor residue', s.sel === 1 && s.ariaSel === 1)

  await page.keyboard.press('End')
  await page.waitForTimeout(150)
  s = await state()
  ok(`End jumps to last tile (hover=${N - 1})`, s.hover === N - 1)

  await page.keyboard.press('Home')
  await page.waitForTimeout(150)
  s = await state()
  ok('Home jumps to first tile', s.hover === 0)

  // Panel-root stepping must still work when the strip is NOT focused:
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  s = await state()
  ok('Escape blurs the strip and clears the cursor', !s.focused && s.hover === -1)

  // Focus the pv-root that owns THIS strip (sessions may contain several panels).
  await page.evaluate(() => document.querySelector('.pv-seqstrip').closest('.pv-root').focus())
  await page.waitForTimeout(200)
  const prevSel = (await state()).sel
  await page.keyboard.press('ArrowRight')
  await page.waitForTimeout(200)
  s = await state()
  ok(
    `panel-root ←/→ stepping still works (selected ${prevSel} → ${prevSel + 1})`,
    s.sel === prevSel + 1 && s.hover === s.sel,
  )

  if (fail.length) throw new Error(`${fail.length} failed`)
  console.log('KBD LIVE OK')
} catch (e) {
  console.log('KBD LIVE FAIL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
