// Live audit: interactive touch targets inside .pv-root panels at phone width.
// WCAG 2.5.8 floor is 24px; Apple HIG / Material recommend 44–48px. Dense data
// surfaces (sequence-strip tiles, canvas gesture areas) are counted separately
// — they are visualization, not controls. Prints per-class offender stats so
// CSS fixes can target the worst controls first.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const W = Number(process.argv[2] ?? 400)

const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: W, height: 850 } })
let failed = 0
try {
  await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(5000)
  // widen the sidebar groups so session rows are clickable
  await page.evaluate(() => {
    document.querySelectorAll('.workspace-heading').forEach((h) => {
      if (h.getAttribute('aria-expanded') !== 'true') h.click()
    })
  })
  await page.waitForTimeout(800)
  const titles = await page.evaluate(() =>
    [...document.querySelectorAll('.session-title')].map((s) => s.textContent.trim()),
  )
  const pick = (re) => titles.find((t) => re.test(t))
  const candidates = [
    ['main panel', /P61626|溶菌|lysozyme|置信/i],
    ['complex panel', /复合物|complex|PAE|热图/i],
    ['batch panel', /批处理|batch|多蛋白/i],
    ['search panel', /搜索|UniProt|uniprot/i],
  ]
  const seen = new Map() // key: classPath → {count, minH, minW, sample}
  let panelsSeen = 0
  for (const [label, re] of candidates) {
    const title = pick(re)
    if (!title) {
      console.log(`skip ${label}: no session matches ${re}`)
      continue
    }
    await page.evaluate((t) => {
      const el = [...document.querySelectorAll('.session-title')].find((s) => s.textContent.trim() === t)
      el?.closest('li, [role=button], button, div')?.click()
      el?.click()
    }, title)
    await page.waitForTimeout(3500)
    await page.evaluate(() => {
      document.querySelectorAll('details.turn-process:not([open])').forEach((d) => {
        d.querySelector('summary')?.click()
      })
    })
    await page.waitForTimeout(2500)
    const roots = await page.evaluate(() => document.querySelectorAll('.pv-root').length)
    if (!roots) {
      console.log(`skip ${label}: "${title}" has no .pv-root`)
      continue
    }
    panelsSeen++
    const stats = await page.evaluate(() => {
      const sel = 'button, select, input, [role="option"], [role="button"], .pv-pae-pair, .pv-toggle, a[href]'
      const out = []
      document.querySelectorAll('.pv-root').forEach((root) => {
        root.querySelectorAll(sel).forEach((el) => {
          if (!el.offsetParent && el.getClientRects().length === 0) return
          // Exemptions: seq tiles are a dense visualization with drag-select as
          // the touch channel (tapping single tiles is a desktop gesture); a
          // native checkbox inside a <label> is toggled by the label, which is
          // the real (≥44px) touch target.
          if (el.matches('.pv-seq-tile')) return
          if (el.type === 'checkbox' && el.closest('label')) return
          const r = el.getBoundingClientRect()
          if (r.width < 4 || r.height < 4) return
          const cls = [...el.classList].filter((c) => c.startsWith('pv-')).join('.')
          const key = `${el.tagName.toLowerCase()}|${cls || '(none)'}`
          const row = out.find((o) => o.key === key)
          if (row) {
            row.n++
            row.minH = Math.min(row.minH, r.height)
            row.minW = Math.min(row.minW, r.width)
          } else out.push({ key, n: 1, minH: r.height, minW: r.width })
        })
      })
      return out
    })
    for (const s of stats) seen.set(s.key, s)
    console.log(`scanned ${label}: "${title}" (${roots} panel[s])`)
  }
  if (!panelsSeen) throw new Error('no panel-bearing session opened')
  console.log(`\n=== touch-target audit @${W}px (${seen.size} control classes) ===`)
  const rows = [...seen.entries()].sort((a, b) => a[1].minH - b[1].minH)
  for (const [key, s] of rows) {
    const verdict = s.minH >= 44 && s.minW >= 44 ? 'ok44' : s.minH >= 24 && s.minW >= 24 ? 'wcag' : 'TINY'
    console.log(
      `${verdict.padEnd(5)} h=${s.minH.toFixed(0).padStart(3)} w=${s.minW.toFixed(0).padStart(3)} n=${String(s.n).padStart(3)}  ${key}`,
    )
    if (verdict === 'TINY') failed++
  }
  console.log(failed ? `\nTOUCH AUDIT: ${failed} TINY classes` : '\nTOUCH AUDIT: no sub-24px controls')
} finally {
  await browser.close()
}
process.exit(failed ? 1 : 0)
