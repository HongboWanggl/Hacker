// Live check: does the PAE heatmap overflow horizontally at phone width when
// the matrix is longer than the viewport (e.g. 609 aa albumin → n=609, px=609
// vs a ~350px card)? Opens historical PAE-bearing sessions at 400px and measures.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`

const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 400, height: 850 } })
let failed = 0
const ok = (name, cond, extra = '') => {
  console.log(cond ? 'ok ' : 'FAIL', name, extra)
  if (!cond) failed++
}
try {
  await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(5000)
  const candidates = await page.evaluate(() =>
    [...document.querySelectorAll('.session-title')]
      .map((s) => s.textContent.trim())
      .filter((t) => /PAE|热图|复合物|complex|白蛋白|albumin|Boltz|predict_complex|置信/i.test(t)),
  )
  console.log('candidates:', candidates.length)
  let opened = false
  for (const title of candidates) {
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
    if (await page.evaluate(() => !!document.querySelector('canvas.pv-pae-canvas'))) {
      opened = true
      console.log('opened PAE session:', title)
      break
    }
  }
  if (!opened) throw new Error('no PAE-bearing session found at phone width')
  ok('PAE module mounts at 400 px', true)

  const m = await page.evaluate(() => {
    const body = document.querySelector('.pv-pae-body')
    const canvas = document.querySelector('canvas.pv-pae-canvas')
    const root = document.querySelector('.pv-pae')
    return {
      canvasCssW: canvas ? Math.round(canvas.getBoundingClientRect().width) : 0,
      bodyScrollW: body ? body.scrollWidth : 0,
      bodyClientW: body ? body.clientWidth : 0,
      rootClientW: root ? root.clientWidth : 0,
      docScrollW: document.documentElement.scrollWidth,
      innerW: window.innerWidth,
    }
  })
  console.log('metrics:', JSON.stringify(m))
  ok(
    `heatmap fits the phone card (canvas ${m.canvasCssW}px, card ${m.rootClientW}px)`,
    m.canvasCssW <= m.rootClientW,
  )
  ok('no horizontal overflow at 400 px', m.docScrollW <= m.innerW + 1, `doc ${m.docScrollW} vs ${m.innerW}`)

  // Hover readout still works on a CSS-scaled canvas (relative math). Center
  // the canvas first — its lower half may sit under the fixed composer overlay
  // after the transcript auto-scrolls, which swallows real mouse events.
  await page.evaluate(() =>
    document.querySelector('canvas.pv-pae-canvas').scrollIntoView({ block: 'center' }),
  )
  await page.waitForTimeout(400)
  const hbox = await page.locator('canvas.pv-pae-canvas').boundingBox()
  if (hbox) {
    await page.mouse.move(hbox.x + hbox.width * 0.4, hbox.y + hbox.height * 0.6)
    await page.waitForTimeout(400)
    const r = await page.evaluate(
      () => document.querySelector('.pv-pae-side .pv-hoverline')?.textContent ?? '',
    )
    ok(`hover readout on scaled canvas (got "${r.slice(0, 40)}")`, r.includes('·'))
  }
} catch (e) {
  console.log('FAIL', e?.message ?? e)
  failed++
}
await browser.close()
console.log(failed ? 'PAE MOBILE FAIL' : 'PAE MOBILE OK')
process.exit(failed ? 1 : 0)
