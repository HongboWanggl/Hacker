// Retry smoke: seed a failed task into localStorage, open its result page,
// assert the one-click retry button, click it, and require a NEW running task
// of the same type to appear in the store (redirects to #/tasks).
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
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  ...(httpCreds ? { httpCredentials: httpCreds } : {}),
})
if (httpCreds) await login(ctx.request, base, httpCreds)
const page = await ctx.newPage()

const seed = {
  id: 'tretryseed01',
  type: 'single',
  title: '重试探针',
  input: { accession: 'P69905' },
  status: 'failed',
  stages: [],
  savedTo: {},
  error: '模拟失败：TRANSPORT stall（探针注入）',
  sessionId: 'agnes:local:local-dev:cli:workspace:0000000000000000',
  createdAt: Date.now(),
  updatedAt: Date.now(),
}
await ctx.addInitScript((s) => localStorage.setItem('pp-tasks-v1', JSON.stringify([s])), seed)
await page.goto(`${base}#/task/tretryseed01`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page
  .waitForSelector('.pl-error-banner', { timeout: 30000 })
  .catch(() => fail.push('error banner missing'))
const btn = page.locator('button.pl-back', { hasText: '重新提交' }).first()
await btn.waitFor({ timeout: 15000, state: 'visible' }).catch(() => fail.push('retry button missing'))
if (fail.length === 0) {
  await btn.click()
  await page
    .waitForFunction(
      (old) => {
        const t = JSON.parse(localStorage.getItem('pp-tasks-v1') ?? '[]')
        return t.length >= 2 && t[0].id !== old && t[0].type === 'single' && t[0].status === 'running'
      },
      seed.id,
      { timeout: 30000 },
    )
    .catch(() => fail.push('retry click did not start a new task'))
  await page.screenshot({ path: '/tmp/pp-retry-smoke.png' })
}
await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('retry smoke: PASS')
