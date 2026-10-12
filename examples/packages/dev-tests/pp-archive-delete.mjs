// Archive delete probe: fabricate an archive via POST, then delete it through
// the tasks-page UI (two-click confirm) and verify the server copy is gone.
//   node pp-archive-delete.mjs [--shots]
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const SHOTS = process.argv.includes('--shots')
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
// PP_BASE/PP_USER/PP_PASS: drive a remote deployment (see pp-complex-full.mjs).
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const httpCreds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const origin = new URL(base).origin
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({
  viewport: { width: 1400, height: 1000 },
  ...(httpCreds ? { httpCredentials: httpCreds } : {}),
})

// Seed a disposable archive (the UI delete must never touch real results).
const seeded = await page.request
  .post(`${base}api/archive`, {
    headers: { origin },
    data: {
      taskId: 'zz-del-probe',
      type: 'single',
      title: '删除探针',
      meanPlddt: 88.1,
      verdict: '高置信结构',
      files: {},
    },
  })
  .then((r) => r.status())
if (seeded !== 200) {
  console.error(`FAIL: seed archive HTTP ${seeded}`)
  process.exit(1)
}

await page.goto(`${base}#/tasks`, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForSelector('.pl-tasklist', { timeout: 20000 })
const row = page.locator('a.pl-taskrow', { hasText: '删除探针' })
if ((await row.count()) === 0) fail.push('seeded archive row not visible on tasks page')

// Click 1: arm (✕ → 确认删除), row still present.
const del = row.locator('button.pl-row-del')
await del.click()
const armed = await del.textContent()
if (!/确认删除/.test(armed ?? '')) fail.push(`first click did not arm (got: ${armed})`)

// Click 2: confirm → row gone, server 404.
await del.click()
await row
  .waitFor({ state: 'detached', timeout: 10000 })
  .catch(() => fail.push('row did not disappear after confirm'))
const after = await page.request.get(`${base}api/archive/zz-del-probe/meta`)
if (after.status() !== 404) fail.push(`archive still on server after UI delete (HTTP ${after.status()})`)
if (SHOTS) await page.screenshot({ path: '/tmp/pp-archive-delete.png' })
await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('archive delete: PASS')
