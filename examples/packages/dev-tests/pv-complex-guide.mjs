// Live E2E: predict_complex without BOLTZ_API_KEY must guide, not dead-end —
// the agent's answer should surface the secrets/boltz key path or the local
// boltz2-community fallback. Agent turns are LLM-routed and occasionally go
// sideways (r26 af-e2e-live2, r33): a finished-but-off answer retries once in
// a fresh session before the suite fails.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

const exe =
  '/Users/wanghanbao/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const browser = await chromium.launch({ executablePath: exe, headless: true })

async function attempt(n) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
  await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForTimeout(5000)
  await page.getByText('protein-predictor').first().click()
  await page.waitForTimeout(2000)
  await page
    .getByRole('button', { name: /new session/i })
    .first()
    .click()
  await page.waitForTimeout(2000)
  const box = page.locator('textarea').first()
  await box.fill(
    '用 predict_complex 预测两条链 MKTAYIAKQRQISFVKSHFSRQ 和 EIAKQGQVTMVIKKSMLEK 的复合物，把工具返回的内容完整转述。',
  )
  await page.keyboard.press('Enter')
  console.log(`submitted (attempt ${n})`)
  let out = null
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(5000)
    out = await page.evaluate(() => {
      const txt = document.body.innerText
      const done = (txt.match(/Completed · took/g) ?? []).length
      return {
        done,
        guide: txt.includes('BOLTZ_API_KEY') && txt.includes('secrets/boltz'),
        local: txt.includes('开源权重') || txt.includes('boltz2-local'),
      }
    })
    if (i % 8 === 0) console.log(`t=${(i + 1) * 5}s`, JSON.stringify(out))
    if (out.done >= 1) break
  }
  const txt = await page.evaluate(() => document.body.innerText)
  const idx = txt.indexOf('Boltz')
  console.log('final:', JSON.stringify(out), 'errors:', JSON.stringify(errors.slice(0, 3)))
  console.log('answer tail:', txt.slice(idx, idx + 400).replace(/\n+/g, ' | '))
  await page.screenshot({ path: `/tmp/pv-complex-guide-a${n}.png` })
  await page.close()
  return out
}

let out = await attempt(1)
if (out && out.done >= 1 && !out.local) {
  console.log('finished but no local fallback surfaced — retrying once (agent turns are LLM-routed)')
  out = await attempt(2)
}
await browser.close()
process.exit(out?.local ? 0 : 1)
