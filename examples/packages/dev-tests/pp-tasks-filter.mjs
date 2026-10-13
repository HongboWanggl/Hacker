// Tasks-page filter smoke: type chips (with counts) narrow both live rows and
// archive rows; the title search narrows further; 全部 restores everything.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
// PP_BASE/PP_USER/PP_PASS: drive a remote deployment (see pp-complex-full.mjs).
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const httpCreds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, ...(httpCreds ? { httpCredentials: httpCreds } : {}) })
page.on('pageerror', (err) => fail.push(`pageerror: ${String(err).slice(0, 120)}`))

await page.goto(`${base}#/tasks`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-filters .pl-type-tab', { timeout: 20000 })
await page.waitForSelector('.pl-taskrow', { timeout: 20000 }).catch(() => fail.push('no task rows at all'))
await page.waitForTimeout(300)

const total = await page.locator('.pl-taskrow').count()
if (total === 0) fail.push('archive is empty — smoke needs history to filter')
else console.log(`total rows: ${total}`)

// Type chip narrows to batch rows only (every visible meta carries the label).
await page.locator('.pl-type-tab', { hasText: '批量' }).click()
await page.waitForTimeout(300)
const batchN = await page.locator('.pl-taskrow').count()
const metas = await page.locator('.pl-taskrow-meta').allTextContents()
if (batchN === 0) fail.push('batch filter shows zero rows')
if (metas.some((t) => !t.includes('批量'))) fail.push('non-batch row visible under 批量 filter')
const batchTab = await page.locator('.pl-type-tab', { hasText: '批量' }).textContent()
const batchExpect = Number((batchTab ?? '').match(/(\d+)\s*$/)?.[1] ?? -1)
if (batchExpect !== batchN) fail.push(`批量 chip count ${batchExpect} ≠ visible rows ${batchN}`)
console.log(`batch rows: ${batchN}`)

// Search narrows within the filter; then a term that matches nothing.
await page.locator('.pl-search').fill('P69905')
await page.waitForTimeout(300)
const searched = await page.locator('.pl-taskrow').count()
if (searched > batchN) fail.push(`search widened the list (${searched} > ${batchN})`)
const emptyMsg = await page.locator('.pl-empty').count()
if (searched === 0 && emptyMsg === 0) fail.push('zero search hits but no empty hint shown')
await page.locator('.pl-search').fill('zzz-no-such-task-zzz')
await page.waitForTimeout(300)
if ((await page.locator('.pl-empty').textContent().catch(() => ''))?.includes('没有匹配') !== true)
  fail.push('no-hit search lacks the 没有匹配 hint')
await page.locator('.pl-search').fill('')
await page.locator('.pl-type-tab', { hasText: '全部' }).click()
await page.waitForTimeout(300)
const restored = await page.locator('.pl-taskrow').count()
if (restored !== total) fail.push(`全部 did not restore ${total} rows (got ${restored})`)

await page.screenshot({ path: '/tmp/pp-tasks-filter.png' })
await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('tasks filter smoke: PASS')
