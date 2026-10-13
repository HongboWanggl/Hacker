// Login-gate helper for the pp-* probes. Since the login page replaced Caddy
// basic auth, remote probes authenticate by POSTing the form (the resulting
// agh_session cookie lands in the shared cookie jar of whatever
// APIRequestContext they pass in — page.request and context.request both work).
// Local loopback runs have no gate: httpCreds is undefined and these are no-ops.
import { chromium } from '/tmp/node_modules/playwright-core/index.mjs'

export function httpCredsFromEnv() {
  return process.env.PP_USER
    ? { username: process.env.PP_USER, password: process.env.PP_PASS ?? '' }
    : undefined
}

export async function login(request, base, creds) {
  if (!creds) return
  const response = await request.post(new URL('/login', new URL(base).origin).href, {
    form: { user: creds.username, password: creds.password, next: base },
    maxRedirects: 0,
  })
  // 302 → next is success; anything else means the credentials were rejected.
  if (response.status() !== 302)
    throw new Error(`login failed for ${creds.username}: HTTP ${response.status()}`)
}

// Full-UI login for probes that must exercise the login page itself: goto a
// gated URL, get redirected to /login, fill the form, submit, land back.
export async function loginViaUi(page, base, creds) {
  await page.goto(base)
  await page.waitForSelector('form[action="/login"] input#user')
  await page.fill('#user', creds.username)
  await page.fill('#password', creds.password)
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login')),
    page.click('button[type=submit]'),
  ])
}

export { chromium }
