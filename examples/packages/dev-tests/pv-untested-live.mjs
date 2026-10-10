import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'
const exe = '/Users/wanghanbao/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const browser = await chromium.launch({ executablePath: exe, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)))
await page.goto('http://127.0.0.1:4177/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(5000)
await page.getByText('protein-predictor').first().click()
await page.waitForTimeout(2000)
await page.getByRole('button', { name: /new session/i }).first().click()
await page.waitForTimeout(2000)
const box = page.locator('textarea').first()
await box.fill('先用 uniprot_search 搜索 human insulin receptor 找到 accession，然后尝试用 predict_complex 预测两条短链 MKTAYIAKQRQISFVKSHFSRQ 和 EIAJKQGQVTMVIKKSMLEK 的复合物。把工具返回的原始信息（包括任何配置指引）完整转述给我。')
await page.keyboard.press('Enter')
console.log('submitted')
// poll the final assistant text for both markers
let out = null
for (let i = 0; i < 66; i++) {
  await page.waitForTimeout(5000)
  out = await page.evaluate(() => {
    const txt = document.body.innerText
    return {
      done: txt.includes('Completed') || txt.includes('停止'),
      hasAcc: /P\d{5}/.test(txt),
      hasBoltzGuide: txt.includes('BOLTZ_API_KEY') || txt.includes('secrets/boltz'),
      len: txt.length,
    }
  })
  if (i % 8 === 0) console.log(`t=${(i + 1) * 5}s`, JSON.stringify(out))
  if (out.done && (out.hasBoltzGuide || i > 50)) break
}
console.log('final:', JSON.stringify(out), 'errors:', JSON.stringify(errors.slice(0, 3)))
// extract the tail of the assistant answer about complex guidance
const snippet = await page.evaluate(() => {
  const txt = document.body.innerText
  const idx = txt.indexOf('predict_complex')
  return txt.slice(idx, idx + 900)
})
console.log('snippet:', snippet.replace(/\n+/g, ' | ').slice(0, 600))
await page.screenshot({ path: '/tmp/pv-untested.png' })
await browser.close()
