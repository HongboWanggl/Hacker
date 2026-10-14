// Dark-mode smoke: theme boot applies .dark before first paint (system
// preference or saved choice), the TopBar toggle flips + persists, and the pv
// result-page sections follow the same class. Light mode stays untouched.
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

// 1) System dark preference → boot script paints dark before React mounts.
{
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
    colorScheme: 'dark',
    ...(httpCreds ? { httpCredentials: httpCreds } : {}),
  })
  if (httpCreds) await login(page.request, base, httpCreds)
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('.pl-theme-btn', { timeout: 15000, state: 'attached' })
  const dark = await page.evaluate(() => ({
    cls: document.documentElement.classList.contains('dark'),
    scheme: document.documentElement.style.colorScheme,
    body: getComputedStyle(document.body).backgroundColor,
  }))
  if (!dark.cls) fail.push('system dark: .dark class not applied by boot script')
  if (dark.scheme !== 'dark') fail.push(`system dark: colorScheme=${dark.scheme}`)
  if (dark.body === 'rgb(245, 247, 251)') fail.push('system dark: body still light bg')
  // Toggle → light, persisted.
  await page.click('.pl-theme-btn')
  const after = await page.evaluate(() => ({
    cls: document.documentElement.classList.contains('dark'),
    saved: localStorage.getItem('pp-theme'),
  }))
  if (after.cls) fail.push('toggle: .dark still set after clicking to light')
  if (after.saved !== 'light') fail.push(`toggle: pp-theme=${after.saved} (want light)`)
  // Reload → explicit choice wins over system dark.
  await page.reload({ waitUntil: 'domcontentloaded' })
  const reloaded = await page.evaluate(() => document.documentElement.classList.contains('dark'))
  if (reloaded) fail.push('reload: explicit light choice lost over system dark')
  await page.click('.pl-theme-btn') // back to dark, saved
  await page.screenshot({ path: '/tmp/pp-dark-home.png' })
  await page.close()
}

// 2) Explicit dark choice carries into a FRESH context (persistence, and the
//    result page's pv sections follow the same class).
{
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
    colorScheme: 'light',
    ...(httpCreds ? { httpCredentials: httpCreds } : {}),
  })
  if (httpCreds) await login(page.request, base, httpCreds)
  await page.goto(`${base}#/tasks`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  if (await page.evaluate(() => document.documentElement.classList.contains('dark')))
    fail.push('fresh context: system light must stay light')
  await page.evaluate(() => localStorage.setItem('pp-theme', 'dark'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.pl-theme-btn', { timeout: 15000, state: 'attached' })
  const dark = await page.evaluate(() => ({
    cls: document.documentElement.classList.contains('dark'),
    btn: document.querySelector('.pl-theme-btn')?.textContent,
    topbar: getComputedStyle(document.querySelector('.pl-topbar')).backgroundColor,
  }))
  if (!dark.cls) fail.push('fresh context: saved dark choice not restored')
  if (dark.btn !== '☀️') fail.push(`toggle icon in dark should be ☀️, got ${dark.btn}`)
  if (dark.topbar === 'rgba(255, 255, 255, 0.82)') fail.push('topbar still light in dark mode')
  await page.screenshot({ path: '/tmp/pp-dark-tasks.png' })
  await page.close()
}

// 3) Result page: pv sections re-skin under .dark (their own index.css block).
{
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
    colorScheme: 'dark',
    ...(httpCreds ? { httpCredentials: httpCreds } : {}),
  })
  if (httpCreds) await login(page.request, base, httpCreds)
  // Latest archived task (any type) — the pv-root must exist and be dark.
  const list = await page.request.get(`${base}api/archive`, { headers: { origin: 'http://127.0.0.1:4177' } })
  const entries = (await list.json()).slice(0, 8)
  const withStructure = entries.find((m) => ['single', 'complex', 'compare'].includes(m.type))
  if (withStructure) {
    await page.goto(`${base}#/task/${withStructure.taskId}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    })
    await page
      .waitForSelector('.pv-root', { timeout: 20000, state: 'attached' })
      .catch(() => fail.push('pv-root missing on result page'))
    const pv = await page.evaluate(() => {
      const el = document.querySelector('.pv-root')
      return el ? getComputedStyle(el).backgroundImage || getComputedStyle(el).backgroundColor : null
    })
    if (pv === null) fail.push('pv-root computed style unavailable')
    else if (/25[0-5], 25[0-5], 25[0-5]/.test(pv) && !pv.includes('17, 30, 43')) {
      // light pv gradient is #fafbfe→#f2f5fa; dark is #171e2b→#121926
      fail.push(`pv-root not re-skinned in dark: ${pv.slice(0, 80)}`)
    }
    await page.screenshot({ path: '/tmp/pp-dark-result.png', fullPage: false })
  }
  await page.close()
}

await browser.close()
if (fail.length) {
  console.error('FAIL:', fail.join(' | '))
  process.exit(1)
}
console.log('dark mode smoke: PASS')
