import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { closeSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Session primitives for the login gate (packages/web-server). Self-contained on
// node:crypto — web-server carries zero dependencies. Passwords use scrypt;
// session cookies carry an HMAC-SHA256-signed claim set shaped like the portal
// identity token (packages/sdk/src/identity.node.ts) but independent of it, so
// the web layer never needs the sdk.

export type SessionUser = { sub: string; role: string }
export type StoredUser = { hash: string; role?: string }

export const SESSION_COOKIE = 'agh_session'
export const SESSION_TTL_S = 30 * 24 * 60 * 60
const MAX_TOKEN_LENGTH = 8_192

// --- passwords ---------------------------------------------------------------
// scrypt$<salthex>$<keyhex> — scryptSync defaults (N=16384, r=8, p=1).

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const key = scryptSync(password, salt, 64)
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, keyHex] = stored.split('$')
  if (scheme !== 'scrypt' || !saltHex || !keyHex || keyHex.length % 2 !== 0) return false
  const expected = Buffer.from(keyHex, 'hex')
  if (expected.length === 0) return false
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length)
  return timingSafeEqual(actual, expected)
}

// --- session secret ----------------------------------------------------------
// <authHome>/session-secret, 32 random bytes base64url, auto-created 0600 on
// first boot. Deleting the file logs every session out (doubles as a kick-all).

let cachedSecret: { home: string; value: string } | null = null

export function loadSecret(authHome: string): string {
  if (cachedSecret?.home === authHome) return cachedSecret.value
  const path = join(authHome, 'session-secret')
  let value: string
  try {
    value = readFileSync(path, 'utf8').trim()
    if (!value) throw new Error('empty session secret')
  } catch {
    value = randomBytes(32).toString('base64url')
    // O_CREATE with mode 0600 — writeFileSync's mode arg is racy on some
    // platforms, so open the descriptor exclusively then write through it.
    const fd = openSync(path, 'w', 0o600)
    try {
      writeFileSync(fd, value)
    } finally {
      closeSync(fd)
    }
  }
  cachedSecret = { home: authHome, value }
  return value
}

// --- session token -----------------------------------------------------------
// base64url(JSON{sub,exp,role}).<hmac-sha256 hex> — same wire shape as the
// portal identity token (identity.node.ts), verified constant-time + expiry.

const digest = (payload: Uint8Array, secret: string) => createHmac('sha256', secret).update(payload).digest()

export function mintSessionToken(user: SessionUser, secret: string): string {
  const claims = { sub: user.sub, exp: Math.floor(Date.now() / 1_000) + SESSION_TTL_S, role: user.role }
  const payload = Buffer.from(JSON.stringify(claims))
  return `${payload.toString('base64url')}.${digest(payload, secret).toString('hex')}`
}

export function verifySessionToken(token: string, secret: string): SessionUser | null {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null
  const [encoded, mac, ...extra] = token.split('.')
  if (!encoded || !mac || extra.length > 0 || !/^[0-9a-f]{64}$/.test(mac)) return null
  const payload = Buffer.from(encoded, 'base64url')
  if (payload.toString('base64url') !== encoded) return null
  const actual = Buffer.from(mac, 'hex')
  if (!timingSafeEqual(digest(payload, secret), actual)) return null
  try {
    const claims: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload))
    if (
      claims === null ||
      typeof claims !== 'object' ||
      typeof (claims as { sub?: unknown }).sub !== 'string' ||
      typeof (claims as { role?: unknown }).role !== 'string' ||
      typeof (claims as { exp?: unknown }).exp !== 'number'
    )
      return null
    const { sub, exp, role } = claims as { sub: string; exp: number; role: string }
    return exp * 1_000 <= Date.now() ? null : { sub, role }
  } catch {
    return null
  }
}

// --- users file & cookies ----------------------------------------------------

let cachedUsers: { path: string; mtimeMs: number; users: Record<string, StoredUser> } | null = null

export function readUsers(authHome: string): Record<string, StoredUser> {
  const path = join(authHome, 'users.json')
  let mtimeMs = 0
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return {}
  }
  if (cachedUsers?.path === path && cachedUsers.mtimeMs === mtimeMs) return cachedUsers.users
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const users: Record<string, StoredUser> = {}
    for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as { hash?: unknown }).hash === 'string'
      )
        users[name] = entry as StoredUser
    }
    cachedUsers = { path, mtimeMs, users }
    return users
  } catch {
    return {}
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim()
  }
  return out
}
