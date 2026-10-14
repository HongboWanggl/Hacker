// Benchmark page probe: locks the #/bench view against a route-injected
// api/bench payload (2 scored targets + 1 pending) — table cells, score pills,
// PDB links, the pLDDT-calibration SVG and the nav entry. No daemon needed.
//   PP_BASE/PP_USER/PP_PASS as usual.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { login } from './pp-login.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const creds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const fail = []

const payload = {
  set: 'CASP14',
  scored: 2,
  updatedAt: new Date().toISOString(),
  calib: [
    { bin: 70, n: 40, meanLddt: 0.72 },
    { bin: 80, n: 60, meanLddt: 0.85 },
    { bin: 90, n: 80, meanLddt: 0.94 },
  ],
  rows: [
    {
      id: 'T1064',
      name: 'ORF8, SARS-CoV2',
      pdb: '7JTL',
      chain: 'A',
      length: 106,
      status: 'done',
      taskId: 'tblah1',
      meanPlddt: 91.3,
      lddt: 0.912,
      rmsd: 0.87,
      nAligned: 102,
    },
    {
      id: 'T1029',
      name: 'EbsA, Cyanobacteria',
      pdb: '6UF2',
      chain: 'A',
      length: 125,
      status: 'done',
      taskId: 'tblah2',
      meanPlddt: 62.5,
      lddt: 0.551,
      rmsd: 3.4,
      nAligned: 125,
    },
    { id: 'T1049', name: 'MrpH, Proteus mirabilis', pdb: '6Y4F', chain: 'A', length: 141, status: 'pending' },
  ],
}

const browser = await chromium.launch({ executablePath: exe, headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
if (creds) await login(ctx.request, base, creds)
const page = await ctx.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[console.error]`, m.text().slice(0, 200))
})
await page.route(
  '**/api/bench',
  (route) =>
    void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) }),
)

await page.goto(`${base}#/bench`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-bench-table', { timeout: 20000 })

// 1. Table: 3 rows, scored cells populated, pending row says 待运行.
const rows = page.locator('.pl-bench-table tbody tr')
if ((await rows.count()) !== 3) fail.push(`rows: expected 3, saw ${await rows.count()}`)
const lddt = await rows.nth(0).locator('.pill').nth(1).textContent()
if (lddt !== '0.912') fail.push(`T1064 lddt pill: "${lddt}"`)
const rmsd = await rows.nth(0).locator('td').nth(6).textContent()
if (rmsd !== '0.87') fail.push(`T1064 rmsd: "${rmsd}"`)
const pending = await rows.nth(2).locator('.bench-pending').textContent()
if (pending !== '待运行') fail.push(`pending cell: "${pending}"`)
// Score-band coloring follows the pLDDT palette: high lddt → b-hi pill.
const cls = await rows.nth(0).locator('.pill').nth(1).getAttribute('class')
if (!cls?.includes('b-hi')) fail.push(`T1064 pill class: "${cls}" (want b-hi)`)
// PDB link deep-links RCSB.
const href = await rows.nth(0).locator('a').getAttribute('href')
if (href !== 'https://www.rcsb.org/structure/7JTL') fail.push(`pdb link: "${href}"`)

// 2. Calibration SVG: bars + ideal diagonal + axis labels.
const bars = page.locator('.pl-cal .cal-bar')
if ((await bars.count()) !== 3) fail.push(`cal bars: expected 3, saw ${await bars.count()}`)
if ((await page.locator('.pl-cal .cal-diag').count()) !== 1) fail.push('cal diagonal missing')
const calNote = await page.locator('.pl-bench-sub').textContent()
if (!calNote?.includes('2 个靶标')) fail.push(`cal subtitle: "${calNote}"`)

// 3. Nav entry routes here from home.
await page.goto(`${base}#/`, { waitUntil: 'domcontentloaded', timeout: 30000 })
await page.click('.pl-nav a:has-text("基准")')
await page.waitForSelector('.pl-bench-table', { timeout: 10000 })
const navOn = await page.locator('.pl-nav a.on').textContent()
if (navOn !== '基准') fail.push(`nav highlight: "${navOn}"`)

await page.screenshot({ path: '/tmp/pp-bench-page.png', fullPage: true })
await browser.close()
if (fail.length) {
  console.log('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('bench-page probe: PASS')
