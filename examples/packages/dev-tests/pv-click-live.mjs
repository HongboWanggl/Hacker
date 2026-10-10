// Live E2E: 3D click-to-select. A click (pointerdown→up, <5px movement) on the
// 3D canvas selects the picked residue — hoverline gains the 已选 readout and
// the selection survives hover-elsewhere (hover keeps priority in the readout).
// Uses the historical compare_structures session (now titled 比较两个PDB文件结构).
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
const exe = '/Users/wanghanbao/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
const clicked = await page.evaluate(() => {
  const spans = [...document.querySelectorAll('.session-title')]
  const el = spans.find((s) => s.textContent.includes('比较两个PDB文件结构'))
  if (!el) return 'not found'
  el.closest('li, [role=button], button, div')?.click()
  el.click()
  return 'clicked'
})
if (clicked !== 'clicked') { console.log('FAIL session not found'); process.exit(1) }
console.log(clicked)
await page.waitForTimeout(5000)
await page.evaluate(() => {
  document.querySelectorAll('details.turn-process:not([open])').forEach((d) => d.querySelector('summary')?.click())
})
await page.waitForTimeout(5000)
await page.evaluate(() => document.querySelector('.pv-3d')?.scrollIntoView({ block: 'center' }))
await page.waitForTimeout(800)
await page.evaluate(() => document.querySelector('.pv-3d')?.scrollIntoView({ block: 'center' }))
await page.waitForTimeout(800)

const canvas = page.locator('.pv-3d').first()
const bb = await canvas.boundingBox().catch(() => null)
const ok = (name, cond) => { console.log(cond ? 'ok ' : 'FAIL', name); if (!cond) process.exitCode = 1 }
let hoverText = ''
if (bb) {
  // find a residue via hover first, then click the same spot
  await page.mouse.move(bb.x + bb.width * 0.42, bb.y + bb.height * 0.45)
  await page.waitForTimeout(600)
  await page.mouse.move(bb.x + bb.width * 0.44, bb.y + bb.height * 0.47, { steps: 4 })
  await page.waitForTimeout(900)
  hoverText = await page.evaluate(() => [...document.querySelectorAll('.pv-hoverline')].map((e) => e.textContent).filter(Boolean).join(' | '))
  console.log('hover:', hoverText.slice(0, 160))
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(900)
  // Readout rule: hover has priority, so the 已选 prefix appears once the
  // pointer leaves the residue (selIdx still set). Move to canvas corner.
  await page.mouse.move(bb.x + 4, bb.y + 4, { steps: 4 })
  await page.waitForTimeout(900)
  const away = await page.evaluate(() => [...document.querySelectorAll('.pv-hoverline')].map((e) => e.textContent).filter(Boolean).join(' | '))
  ok('click selects residue (已选 readout)', away.includes('已选'))
  // NOTE: not asserting the clicked residue == hovered residue — autoSpin keeps
  // rotating between hover capture and click, so the residue under the cursor
  // legitimately shifts. Selection semantics are what we verify here.
  console.log('away:', away.slice(0, 200))
  // click the same spot again — toggle selection off (chip cycle) or reselect
  await page.mouse.move(bb.x + bb.width * 0.44, bb.y + bb.height * 0.47, { steps: 4 })
  await page.waitForTimeout(600)
  await page.mouse.down()
  await page.mouse.up()
  await page.waitForTimeout(600)
  await page.mouse.move(bb.x + 4, bb.y + 4, { steps: 4 })
  await page.waitForTimeout(900)
  const after2 = await page.evaluate(() => [...document.querySelectorAll('.pv-hoverline')].map((e) => e.textContent).filter(Boolean).join(' | '))
  ok('second click toggles selection off', !after2.includes('已选'))
} else {
  ok('3D canvas present', false)
}
ok('no page errors', errors.length === 0)
await browser.close()
console.log('CLICK TEST DONE')
process.exit(process.exitCode ?? 0)
