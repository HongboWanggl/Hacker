// Wall thumbnail probe: home shows archived cards with a Cα-trace SVG figure.
//   node pp-thumb-wall.mjs [--shots]
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { login } from './pp-login.mjs'

const SHOTS = process.argv.includes('--shots')
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
// PP_BASE/PP_USER/PP_PASS: drive a remote deployment (see pp-complex-full.mjs).
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const httpCreds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({
  viewport: { width: 1400, height: 1100 },
  ...(httpCreds ? { httpCredentials: httpCreds } : {}),
})
if (httpCreds) await login(page.request, base, httpCreds)
await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-wall', { timeout: 20000 })
// Thumbnails mount after the archive list lands; wait for at least one SVG.
await page
  .waitForSelector('a.pl-card-fig svg.pl-thumb path', { timeout: 15000 })
  .then(() => console.log('thumbnail: rendered'))
  .catch(() => fail.push('no .pl-thumb SVG on wall cards'))
const stats = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('a.pl-card-fig')]
  const thumbs = [...document.querySelectorAll('svg.pl-thumb')]
  return {
    figCards: cards.length,
    thumbs: thumbs.length,
    paths: thumbs.reduce((s, t) => s + t.querySelectorAll('path').length, 0),
    strokes: [
      ...new Set([
        ...thumbs.flatMap((t) => [...t.querySelectorAll('path')].map((p) => p.getAttribute('stroke'))),
      ]),
    ],
  }
})
console.log('stats:', JSON.stringify(stats))
if (stats.thumbs === 0 || stats.paths === 0) fail.push('thumbnail rendered but empty')
if (stats.strokes.some((c) => !c || !/^#/.test(c))) fail.push('invalid band colors')
if (SHOTS) await page.screenshot({ path: '/tmp/pp-wall-thumbs.png', fullPage: true })
await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('wall thumbnails: PASS')
