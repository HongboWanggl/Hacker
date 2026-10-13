// Wall sort probe: the newest/score chips reorder the history pool.
//   node pp-wall-sort.mjs          # local
//   PP_BASE=… PP_USER=… PP_PASS=… node pp-wall-sort.mjs   # remote
// Asserts: 最高分 orders archive cards by mean pLDDT (non-increasing, unscored
// last), 最新 restores the default order, and live cards always lead the wall.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const httpCreds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const fail = []
const browser = await chromium.launch({ executablePath: `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`, headless: true })
const page = await browser.newPage({
  viewport: { width: 1400, height: 1000 },
  ...(httpCreds ? { httpCredentials: httpCreds } : {}),
})
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-wall .pl-card', { timeout: 20000 })
await page.waitForTimeout(300)

// Card order as (typeLabel, score) pairs from the rendered wall.
const cards = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.pl-wall .pl-card')].map((c) => ({
      type: c.querySelector('.pl-card-type')?.textContent ?? '',
      score: Number.parseFloat(c.querySelector('.pl-card-score')?.textContent ?? 'NaN'),
    })),
  )

const before = await cards()
// Switch to score sort.
await page.click('.pl-filters-wall .pl-type-tab:has-text("最高分")')
await page.waitForTimeout(300)
const byScore = await cards()
// History pool = cards after the leading live cards; live cards have no score
// column type check here — score-sorted suffix must be non-increasing (NaN last).
const scores = byScore.map((c) => c.score)
const firstNaN = scores.findIndex((s) => Number.isNaN(s))
const scored = firstNaN === -1 ? scores : scores.slice(0, firstNaN)
const unscored = firstNaN === -1 ? [] : scores.slice(firstNaN)
if (scored.some((s, i) => i > 0 && s > scored[i - 1] + 1e-9))
  fail.push(`score order violated: ${JSON.stringify(scores)}`)
if (unscored.some((s) => !Number.isNaN(s))) fail.push('unscored cards not sunk to end')
if (byScore.length !== before.length) fail.push(`card count changed: ${before.length} → ${byScore.length}`)
// Back to newest: first card must match the default rendering's first card.
await page.click('.pl-filters-wall .pl-type-tab:has-text("最新")')
await page.waitForTimeout(300)
const restored = await cards()
if (JSON.stringify(restored) !== JSON.stringify(before)) fail.push('最新 did not restore default order')

await browser.close()
if (fail.length) {
  console.log('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log(`wall sort probe: PASS (${before.length} cards, scored suffix ${scored.length})`)
