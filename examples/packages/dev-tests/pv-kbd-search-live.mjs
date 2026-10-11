// Live regression: search-table keyboard roving (round 42). Opens a
// historical UniProt-search session, focuses the first hit row, and drives it
// with REAL key events — ArrowDown/ArrowUp/Home/End rove focus, Space ticks
// the batch checkbox, click still copies. Rows are native buttons, so Tab and
// Enter come for free; this probe covers the roving keys added on top.
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

  // Session titles rotate — try content candidates until one renders a search table.
  const candidates = [
    '检索UniProtKB.*lysozyme|搜索.*UniProt|UniProt.*搜索|Lysozyme|溶菌酶',
    'uniprot_search|UniProtKB',
  ]
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
    if (await page.evaluate(() => document.querySelectorAll('.pv-search-row').length > 0)) {
      opened = true
      break
    }
  }
  if (!opened) throw new Error('no search-table session found in sidebar')

  const table = page.locator('.pv-search-table').first()
  await table.scrollIntoViewIfNeeded()
  const N = await page.evaluate(() => document.querySelectorAll('.pv-search-row').length)
  ok(`search table mounted (${N} rows)`, N > 1)

  const state = () =>
    page.evaluate(() => {
      const rows = [...document.querySelectorAll('.pv-search-row')]
      return {
        focused: rows.indexOf(document.activeElement),
        sel: rows.filter((r) => r.classList.contains('pv-search-row--sel')).length,
        pressed: rows.map((r) => r.getAttribute('aria-pressed')),
        batch: document.querySelector('.pv-batchbar-count')?.textContent ?? '',
      }
    })

  await page.evaluate(() => document.querySelector('.pv-search-row').focus())
  await page.waitForTimeout(200)
  await page.keyboard.press('ArrowDown')
  await page.waitForTimeout(150)
  let s = await state()
  ok('ArrowDown roves row focus to #2', s.focused === 1)
  await page.keyboard.press('End')
  await page.waitForTimeout(150)
  s = await state()
  ok(`End jumps to last row (#${N})`, s.focused === N - 1)
  await page.keyboard.press('Home')
  await page.waitForTimeout(150)
  s = await state()
  ok('Home jumps back to first row', s.focused === 0)

  await page.keyboard.press(' ')
  await page.waitForTimeout(200)
  s = await state()
  ok('Space ticks the focused row (batch bar counts 1)', s.sel === 1 && s.pressed[0] === 'true')
  ok(`batch bar visible (${s.batch.trim()})`, s.batch.includes('1'))

  await page.keyboard.press(' ')
  await page.waitForTimeout(200)
  s = await state()
  ok('Space again unticks the row', s.sel === 0 && s.pressed[0] === 'false')

  if (fail.length) throw new Error(`${fail.length} failed`)
  console.log('KBD SEARCH LIVE OK')
} catch (e) {
  console.log('KBD SEARCH LIVE FAIL:', e.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
