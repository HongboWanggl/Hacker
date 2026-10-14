// Screenshots + DOM contract for the login landing page.
//
//   node --import tsx pp-login-shots.mts [outDir]
//
// Starts the REAL web-server (`createWebServer`) on a scratch port and drives
// GET /login, so what is captured is the shipped renderer, not a copy of the
// markup. The contract half matters as much as the pixels: pp-login.mjs drives
// the form by `#user`/`#password`/`button[type=submit]` and pp-guest-gate.mjs
// depends on the same, so a prettier page that renames a field would break the
// deploy probes silently.
import { mkdirSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { createWebServer } from '../../../packages/web-server/src/server.ts'

const outDir = process.argv[2] ?? '/tmp/pp-login-shots'
mkdirSync(outDir, { recursive: true })

const root = await mkdtemp(join(tmpdir(), 'pp-login-root-'))
const port = 44177
const web = await createWebServer({ root, wsUrl: 'ws://127.0.0.1:1/agnesd', port })

const failures: string[] = []
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, extra)
  if (!cond) failures.push(name)
}

const browser = await chromium.launch({
  executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
  headless: true,
})

type Shot = { name: string; width: number; height: number; query: string }
const shots: Shot[] = [
  { name: 'desktop', width: 1440, height: 900, query: '' },
  { name: 'desktop-error', width: 1440, height: 900, query: '?error=1' },
  { name: 'mobile', width: 390, height: 844, query: '' },
]

for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: shot.width, height: shot.height } })
  const res = await page.goto(`http://127.0.0.1:${port}/login${shot.query}`, { waitUntil: 'load' })
  ok(`${shot.name}: 200`, res?.status() === 200, String(res?.status()))
  // The three-selector contract the deploy probes drive.
  for (const [label, sel] of [
    ['form', 'form[action="/login"]'],
    ['user', 'form[action="/login"] input#user'],
    ['password', 'form[action="/login"] input#password'],
    ['next', 'form[action="/login"] input[name=next]'],
    ['submit', 'form[action="/login"] button[type=submit]'],
  ] as const) {
    ok(`${shot.name}: ${label} present`, (await page.locator(sel).count()) === 1)
  }
  // Real structure data, not decoration. The generator emits one path per
  // (chain, pLDDT band), so the count is small but the geometry is not: assert
  // both, otherwise a truncated/empty figure would still pass a count check.
  ok(`${shot.name}: three figures`, (await page.locator('.fig').count()) === 3)
  const paths = await page.locator('.fig svg path').count()
  const dLen = await page.evaluate(() =>
    [...document.querySelectorAll('.fig svg path')].reduce(
      (n, p) => n + (p.getAttribute('d') ?? '').length,
      0,
    ),
  )
  ok(`${shot.name}: structure paths rendered`, paths >= 8 && dLen > 8000, `${paths} paths, ${dLen} chars`)
  // No horizontal overflow — the page must not scroll sideways at any width.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  )
  ok(`${shot.name}: no h-overflow`, overflow <= 0, `${overflow}px`)
  ok(`${shot.name}: brand visible`, await page.locator('text=ProteinLens').first().isVisible())
  ok(`${shot.name}: real-figure caption visible`, await page.locator('text=CASP14 T1025').first().isVisible())
  await page.screenshot({ path: join(outDir, `${shot.name}.png`), fullPage: true })
  await page.close()
}

// The error variant must still say so, in the same box as the form.
const errPage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await errPage.goto(`http://127.0.0.1:${port}/login?error=1`)
ok('error: message shown', await errPage.locator('.error').first().isVisible())
ok(
  'error: text is the honest one',
  (await errPage.locator('.error').first().innerText()).includes('账号或密码不对'),
)
await errPage.close()

await browser.close()
await web.close()
console.log(
  failures.length === 0 ? `login shots: PASS → ${outDir}` : `login shots: ${failures.length} FAILURES`,
)
process.exit(failures.length === 0 ? 0 : 1)
