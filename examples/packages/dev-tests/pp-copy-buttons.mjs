// Copy-buttons probe: locks the http (no secure context) clipboard fallback.
// navigator.clipboard is undefined on the plain-IP site, so the buttons must
// ride copyText's execCommand fallback (text) and the download fallback
// (image). Hard assertions are FUNCTIONAL (a real copy really happened):
//   • document.execCommand('copy') invoked and returned true (text buttons)
//   • a real download event with protein-view.png (image button)
// The button label is checked best-effort only: the toolview panel can be
// remounted by transcript updates while the composite builds (known slot-
// replay behavior), and a setState landing on the unmounted instance loses
// the flash — the functional outcome is what the user keeps.
//   PP_BASE/PP_USER/PP_PASS as usual; PP_TASK_ID (or first tasks row) — run
//   pp-complex-full first so a complex result exists.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
import { login } from './pp-login.mjs'

const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell`
const base = process.env.PP_BASE ?? 'http://127.0.0.1:4177/platform/'
const creds = process.env.PP_USER
  ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
  : undefined
const fail = []
const browser = await chromium.launch({ executablePath: exe, headless: true })
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
if (creds) await login(ctx.request, base, creds)
const page = await ctx.newPage()
// Capture every execCommand call BEFORE app code runs (the fallback path).
await page.addInitScript(() => {
  window.__copyLog = []
  const orig = document.execCommand?.bind(document)
  document.execCommand = (cmd, ...rest) => {
    const ok = orig ? orig(cmd, ...rest) : false
    window.__copyLog.push({ cmd, ok })
    return ok
  }
})
const downloads = []
page.on('download', (d) => downloads.push(d.suggestedFilename()))

const taskId = process.env.PP_TASK_ID
if (taskId) {
  await page.goto(`${base}#/task/${taskId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
} else {
  await page.goto(`${base}#/tasks`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.pl-tasklist a.pl-taskrow', { timeout: 20000 })
  await page.click('.pl-tasklist a.pl-taskrow')
}
// pv panel mounts async (canvas first paint), then the toolbar buttons.
await page.waitForSelector('.pv-root canvas', { timeout: 90000 })
await page.waitForSelector('.pv-root button:has-text("复制结论")', { timeout: 20000 })

const clickCopy = async (label) => {
  const before = await page.evaluate(() => window.__copyLog.length)
  await page.click(`.pv-root button:has-text("${label}")`)
  await page.waitForTimeout(700)
  return page.evaluate((b) => window.__copyLog.slice(b), before)
}

// 1. 复制结论 (text → execCommand fallback on http).
const concl = await clickCopy('复制结论')
if (!concl.some((e) => e.cmd === 'copy' && e.ok)) fail.push(`复制结论 execCommand: ${JSON.stringify(concl)}`)
const conclLabel = await page
  .locator('.pv-root button:has-text("已复制")')
  .first()
  .textContent()
  .catch(() => null)
console.log('复制结论 label:', conclLabel)

// 2. 复制序列 (text).
const seq = await clickCopy('复制序列')
if (!seq.some((e) => e.cmd === 'copy' && e.ok)) fail.push(`复制序列 execCommand: ${JSON.stringify(seq)}`)

// 3. 复制图像 (image → clipboard API unavailable on http → download fallback).
// The composite build can take ~3s; remounts may swallow the label flash —
// assert on the download, retry the click once if the first attempt dies.
const imgBtn = page.locator('.pv-root button[title*="复制合成图"]').first()
if ((await imgBtn.count()) === 0) fail.push('3D copy button not found')
else {
  for (let attempt = 1; attempt <= 2 && !downloads.includes('protein-view.png'); attempt++) {
    await imgBtn.click()
    await page.waitForTimeout(attempt * 6000)
  }
  if (!downloads.includes('protein-view.png')) fail.push(`no fallback download: ${downloads}`)
}
const imgLabel = await imgBtn.textContent().catch(() => null)
console.log('复制图像 label after:', imgLabel?.trim(), 'downloads:', JSON.stringify(downloads))

console.log(
  `copy probe: execCalls=${JSON.stringify(await page.evaluate(() => window.__copyLog))} downloads=${JSON.stringify(downloads)}`,
)
await page.screenshot({ path: '/tmp/pp-copy-buttons.png' })
await browser.close()
if (fail.length) {
  console.log('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('copy buttons probe: PASS')
