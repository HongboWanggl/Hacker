// Composer live-inspect smoke: typing in the home composer surfaces an inspect
// strip (what the platform parsed / will drop) before any task is committed.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { login } from './pp-login.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
// PP_BASE/PP_USER/PP_PASS: drive a remote deployment (see pp-complex-full.mjs).
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const httpCreds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, ...(httpCreds ? { httpCredentials: httpCreds } : {}) })
if (httpCreds) await login(page.request, base, httpCreds)
page.on('pageerror', (err) => fail.push(`pageerror: ${String(err).slice(0, 120)}`))

await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
const ta = page.locator('.pl-composer textarea')
await ta.waitFor({ timeout: 20000 })

// chips(text, type?) → the strip's chip texts for a given composer input
const chips = async (text, type) => {
  // Scope to the composer: the wall filter row (same .pl-type-tab class) also
  // lives on the home page now.
  if (type) {
    await page.locator('.pl-composer .pl-type-tab', { hasText: type }).click()
    // Tab switch re-renders the composer textarea; settle so the fill below
    // can't land in the pre-switch node (cold remote load race).
    await page.waitForTimeout(300)
  }
  await ta.fill(text)
  await page.locator('.pl-inspect').waitFor({ timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(150)
  return page
    .locator('.pl-chip')
    .allTextContents()
    .catch(() => [])
}
const expectChip = (got, want, label) => {
  if (!got.some((t) => t.includes(want))) fail.push(`${label}: expected chip ~${JSON.stringify(want)}, got ${JSON.stringify(got)}`)
}

const SEQ47 = 'MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHF'

// 1. Raw sequence → parsed residue count.
let got = await chips(SEQ47)
expectChip(got, `原始序列 · ${SEQ47.length} aa`, 'raw sequence')

// 2. UniProt ID (lowercase tolerated).
got = await chips('p69905')
expectChip(got, 'UniProt ID · P69905', 'accession')

// 3. Multi-record FASTA → first record used, extras flagged.
got = await chips(`>sp|P69905|HBA_HUMAN\n${SEQ47}\n>sp|P68871|HBB_HUMAN\nVHLTPEEKSAVTALWGKVNVDEVGGEALGR`)
expectChip(got, `FASTA · ${SEQ47.length} aa`, 'fasta first record')
expectChip(got, '其余 1 条将忽略', 'fasta extras warn')

// 4. Digits inside a long paste → not a sequence, warned loudly.
got = await chips(SEQ47 + '123456')
expectChip(got, '无法识别为序列', 'digits warn')

// 5. Unknown free text → guidance chip.
got = await chips('p53 human')
expectChip(got, '无法识别：请输入 UniProt ID', 'unknown warn')

// 6. Batch: overflow + junk tokens both surfaced.
const tenAccs = ['P69905', 'P68871', 'P04637', 'P02768', 'P01308', 'P61769', 'P00698', 'P00734', 'P05067', 'P00533']
got = await chips([...tenAccs, 'not-an-id'].join('\n'), '批量')
expectChip(got, '8 个 UniProt ID', 'batch cap')
expectChip(got, '最多 8 个，仅取前 8 个', 'batch overflow warn')
expectChip(got, '1 项无法识别，将被忽略', 'batch junk warn')

// 7. Complex: chains counted, short line flagged.
const c1 = 'MVLSPADKTNVKAAWGKVGAHAGEYGAEAL'
const c2 = 'VHLTPEEKSAVTALWGKVNVDEVGGEALGR'
got = await chips([c1, c2, 'MKI'].join('\n'), '复合物')
expectChip(got, `2 条链 · 共 ${c1.length + c2.length} aa`, 'complex chains')
expectChip(got, '1 条链不足 5 aa，将被忽略', 'complex short warn')

// 8. Empty strip when input cleared (no stale chips).
await ta.fill('')
const left = await page.locator('.pl-chip').count()
if (left !== 0) fail.push(`strip not cleared: ${left} chips remain`)

await page.screenshot({ path: '/tmp/pp-composer-inspect.png' })
await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('composer inspect smoke: PASS')
