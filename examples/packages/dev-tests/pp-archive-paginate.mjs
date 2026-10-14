// Archive list pagination probe: locks the tasks-page render window (client
// windowing over the full listArchive pool — filters/search/counts stay exact,
// only the DOM is capped at PAGE=30 rows behind a 加载更多 expander).
// The archive list is served from a route interception (45 synthetic metas,
// each carrying a precomputed thumb so StructureThumb stays fetch-free), so
// the probe needs no real archive data and runs on a fresh deploy.
//   PP_BASE/PP_USER/PP_PASS as usual.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { login } from './pp-login.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const creds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const fail = []
const N = 45
const PAGE = 30

// Newest-first (the server's savedAt sort), precomputed thumbs → zero fetches.
const metas = Array.from({ length: N }, (_, i) => ({
  taskId: `seed${String(i).padStart(2, '0')}`,
  type: 'single',
  title: `历史任务 ${i}`,
  savedAt: new Date(Date.now() - i * 60_000).toISOString(),
  meanPlddt: +(60 + (i % 35)).toFixed(1),
  thumb: { d: ['M2 50L50 20L98 50'], c: ['#65CBF3'] },
}))

const browser = await chromium.launch({ executablePath: exe, headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
if (creds) await login(ctx.request, base, creds)
const page = await ctx.newPage()
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`[console.error]`, m.text().slice(0, 200))
})
await page.route('**/api/archive', (route) => {
  if (route.request().method() === 'GET' && !route.request().url().includes('/api/archive/'))
    void route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(metas) })
  else void route.continue()
})

await page.goto(`${base}#/tasks`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-taskrow', { timeout: 20000 })

const rows = () => page.locator('.pl-tasklist a.pl-taskrow').count()
const title = () => page.locator('.pl-tasklist a.pl-taskrow .pl-taskrow-title').first().textContent()

// 1. Window: PAGE rows rendered, newest first, expander counts the rest.
if ((await rows()) !== PAGE) fail.push(`window: expected ${PAGE} rows, saw ${await rows()}`)
if ((await title()) !== `历史任务 0`) fail.push(`newest-first: first row is "${await title()}"`)
const more = page.locator('button.pl-more')
if (!(await more.isVisible())) fail.push('加载更多 button missing')
else {
  const label = await more.textContent()
  if (!label?.includes(`还有 ${N - PAGE} 条`)) fail.push(`expander label: "${label?.trim()}"`)
}

// 2. Counts stay pool-exact despite the window: chips show 45, not 30.
const allCount = await page.locator('.pl-type-tab', { hasText: '全部' }).locator('em').textContent()
if (allCount !== String(N)) fail.push(`chip count shows ${allCount}, want ${N} (pool-exact)`)

// 3. Expand: all N rows, expander gone.
await more.click()
await page.waitForTimeout(300)
if ((await rows()) !== N) fail.push(`after expand: expected ${N} rows, saw ${await rows()}`)
if (await more.isVisible().catch(() => false)) fail.push('expander still visible after expand')

// 4. Filter/search reset the window and still match the full pool.
await page.locator('.pl-type-tab', { hasText: '全部' }).click() // no-op stability
await page.fill('.pl-search', '历史任务 4')
await page.waitForTimeout(300)
// Matches: 历史任务 4, 40-44 → 6 rows, window must reset (no residual state).
if ((await rows()) !== 6) fail.push(`search "历史任务 4": expected 6 rows, saw ${await rows()}`)

await page.screenshot({ path: '/tmp/pp-archive-paginate.png' })
await browser.close()
if (fail.length) {
  console.log('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('archive-paginate probe: PASS')
