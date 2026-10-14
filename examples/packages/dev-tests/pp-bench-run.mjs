// Benchmark runner: submits the CASP14 targets through the REAL platform
// pipeline (home composer → single prediction → archive) so the bench page
// scores genuine Boltz-2 output. Resumable: targets whose archive already
// exists are skipped, so re-running picks up where an interrupted run stopped.
// Scores land server-side on demand (api/bench title-matches CASP14-<id>).
//   node pp-bench-run.mjs [--fresh]   (PP_BASE/PP_USER/PP_PASS as usual)
// Each monomer is a ~10-25 min GPU job; the whole set is an afternoon.
import { readFileSync } from 'node:fs'
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { login } from './pp-login.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const creds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const TASK_MS = 30 * 60 * 1000 // per-target ceiling (stall watchdog + retry live server-side)

const manifest = JSON.parse(
  readFileSync(new URL('../protein-platform/server/bench/targets.json', import.meta.url), 'utf8'),
)
const targets = manifest.targets // already ascending by length

const browser = await chromium.launch({ executablePath: exe, headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
if (creds) await login(ctx.request, base, creds)
const page = await ctx.newPage()

const doneIds = new Set()
try {
  const list = await (await ctx.request.fetch(`${base}api/bench`)).json()
  for (const r of list.rows) if (r.status === 'done') doneIds.add(r.id)
} catch {
  console.log('warning: could not read api/bench — running all targets')
}

const results = []
for (const t of targets) {
  const title = `CASP14-${t.id}`
  if (doneIds.has(t.id)) {
    console.log(`${t.id}: already scored — skip`)
    results.push({ id: t.id, skipped: true })
    continue
  }
  console.log(`${t.id} (${t.length} aa): submitting…`)
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.pl-composer textarea', { timeout: 20000 })
  await page.fill('.pl-composer textarea', t.sequence)
  await page.fill('.pl-input-name', title)
  await page.click('.pl-submit')
  await page.waitForSelector('.pl-tasklist, .pl-card', { timeout: 15000 })

  await page.goto(`${base}#/tasks`, { timeout: 15000 })
  const outcome = await page
    .waitForSelector(
      '.pl-tasklist a.pl-taskrow:first-child .pl-badge.done, .pl-tasklist a.pl-taskrow:first-child .pl-badge.failed, .pl-tasklist a.pl-taskrow:first-child .pl-badge.cancelled',
      { timeout: TASK_MS, state: 'attached' },
    )
    .then((el) => el.textContent())
    .catch(() => null)
  // The first row must be OUR task (another tester could submit concurrently).
  const firstTitle = await page.locator('.pl-tasklist a.pl-taskrow .pl-taskrow-title').first().textContent()
  const rowIsOurs = (firstTitle ?? '').startsWith(title)
  console.log(`${t.id}: ${outcome}${rowIsOurs ? '' : ` (first row "${firstTitle}" — not ours!)`}`)
  results.push({ id: t.id, outcome, rowIsOurs })
  if (outcome !== '已完成' || !rowIsOurs) {
    // Keep going with the rest; failures surface in the summary.
  }
}

// Final scoreboard from the server (title-matched archives scored on demand).
const bench = await (await ctx.request.fetch(`${base}api/bench`)).json()
console.log('---')
for (const r of results) console.log(JSON.stringify(r))
console.log(
  `bench: ${bench.scored}/${bench.rows.length} scored —`,
  bench.rows
    .filter((r) => r.lddt !== undefined)
    .map((r) => `${r.id}:${r.lddt}(${r.rmsd}Å)`)
    .join(' '),
)
await browser.close()
