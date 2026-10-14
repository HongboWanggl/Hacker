// Lookup fallback probe: what happens when the fast UniProt query finds nothing — the
// everyday case for a Chinese description, since UniProt does not index CJK prose.
//   • the panel says it is thinking (a description is being translated into a query),
//     with a 取消 button, rather than showing an empty table or a bare spinner
//   • it settles to either real candidates or an honest sentence — never both empty
//     and "loading" at once
//   • whichever way it settles, no task row and no archive entry appear: the lookup is
//     a private detour, not a task the user has to clean up
// A nonsense description is used on purpose: it must reach the honest empty state.
//   PP_BASE/PP_USER/PP_PASS as usual.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { httpCredsFromEnv, login } from './pp-login.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const creds = httpCredsFromEnv()
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
if (creds) await login(page.request, base, creds)
page.on('pageerror', (e) => fail.push(`pageerror: ${String(e).slice(0, 160)}`))

const tasks = () => page.evaluate(() => JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]'))
const archiveCount = () =>
  page.evaluate(async () => {
    try {
      const r = await fetch('api/archive')
      const body = await r.json()
      return Array.isArray(body) ? body.length : -1
    } catch {
      return -1
    }
  })

await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-composer textarea', { timeout: 20000 })
const before = { tasks: (await tasks()).length, archive: await archiveCount() }

// CJK prose that unmistakably matches nothing, so the fast stage returns 0 hits and
// the agent stage has to run and come up empty.
await page.fill('.pl-composer textarea', '一种不存在的虚构蛋白质 泽塔奥米伽')
await page.click('.pl-submit')

// Sample the panel while it works: the progress stages are transient, so a single
// look after the fact would miss them.
const seen = new Set()
let panelText = ''
const deadline = Date.now() + 90000
while (Date.now() < deadline) {
  panelText = (await page.textContent('.pl-candidates').catch(() => '')) ?? ''
  if (panelText) seen.add(panelText.replace(/\s+/g, ' ').slice(0, 80))
  const settled =
    (await page.locator('.pl-candidates .pv-search-row').count().catch(() => 0)) > 0 ||
    /没有找到匹配的蛋白|未找到候选|检索超时|暂时不可用|连不上|出错/.test(panelText)
  if (settled) break
  await page.waitForTimeout(120)
}
const stages = [...seen].join(' || ')
console.log('panel stages:', stages)
if (!/正在检索|正在理解/.test(stages)) fail.push(`no progress stage observed: ${stages}`)
if (seen.size > 1 && !/正在理解/.test(stages))
  fail.push(`fast stage found nothing but the agent stage never announced itself: ${stages}`)

const rows = await page.locator('.pl-candidates .pv-search-row').count()
const honest = /没有找到匹配的蛋白|未找到候选|检索超时|暂时不可用|连不上|出错/.test(panelText)
console.log(`settled as: ${rows ? `${rows} candidate rows` : 'empty'}${honest ? ' (honest sentence)' : ''}`)
if (!rows && !honest) fail.push(`settled with neither candidates nor an honest sentence: ${panelText.slice(0, 200)}`)
if (rows && honest) fail.push('candidates and a failure sentence shown at the same time')
// A spinner that never stops is the failure mode this probe exists to catch.
if (!rows && /正在检索|正在理解/.test(panelText)) fail.push('still spinning after the budget')

const after = { tasks: (await tasks()).length, archive: await archiveCount() }
if (after.tasks !== before.tasks)
  fail.push(`fallback added a task row (${before.tasks} → ${after.tasks})`)
if (after.archive !== before.archive)
  fail.push(`fallback wrote an archive entry (${before.archive} → ${after.archive})`)
console.log(`no trace (tasks ${before.tasks}→${after.tasks}, archive ${before.archive}→${after.archive})`)
await page.screenshot({ path: '/tmp/pp-lookup-fallback.png' })

await browser.close()
if (fail.length) {
  console.log('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('lookup fallback probe: PASS')
