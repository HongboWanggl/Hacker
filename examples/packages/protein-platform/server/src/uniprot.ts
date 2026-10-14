import { normalizeLimit, searchUniprotPreferred, UniprotError } from '../../../protein-predictor/uniprot.mjs'

// GET /api/uniprot — the candidate lookup behind the home-page description box.
//
// Why a server route at all: the Surface CSP is `connect-src 'self'`, so the
// browser cannot call rest.uniprot.org; this process can (it is a plain Node
// server with unrestricted egress). Being on the hot path of a text box, the
// route is built to answer fast and never to look like a platform outage:
//   - 8s hard timeout, no retry (the client falls back to the agent instead);
//   - a hit is cached for 10 minutes (the same few descriptions get retyped);
//   - concurrent identical queries share one upstream call;
//   - every failure is a 200 with `{ok:false,reason}` — no 5xx, ever.
const TIMEOUT_MS = 8000
const TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 64

export type Hit = {
  accession: string
  id: string
  proteinName: string
  organism: string
  length: number
}

export type Reason = 'http' | 'network' | 'timeout' | 'aborted' | 'internal'

export type LookupResult =
  | { ok: true; query: string; hits: Hit[]; total?: number; cached?: boolean }
  | { ok: false; reason: Reason }

const cache = new Map<string, { at: number; body: LookupResult }>()
const inflight = new Map<string, Promise<LookupResult>>()

const keyOf = (query: string, limit: number) => `${limit}|${query.trim().toLowerCase()}`

function remember(key: string, body: LookupResult): void {
  cache.delete(key)
  cache.set(key, { at: Date.now(), body })
  while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string)
}

/**
 * Never throws, never returns a partial success: the caller maps `reason` to a
 * message ("UniProt 暂时不可用" vs "没有找到匹配的蛋白" are different stories).
 *
 * Deliberately not wired to the client's disconnect: an in-flight lookup is
 * shared by every caller asking the same thing, so the first one to navigate
 * away must not cancel the answer the others are waiting for. The 8s timeout
 * bounds the work, and the result lands in the cache either way.
 */
export async function uniprotLookup(query: string, limitRaw: unknown): Promise<LookupResult> {
  const limit = normalizeLimit(limitRaw, 8)
  const key = keyOf(query, limit)

  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < TTL_MS) return { ...cached.body, cached: true }

  const pending = inflight.get(key)
  if (pending) return pending

  const run = (async (): Promise<LookupResult> => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const found = await searchUniprotPreferred(fetch, { query, limit, signal: ctrl.signal })
      const body: LookupResult = { ok: true, query, hits: found.hits, total: found.total }
      remember(key, body)
      return body
    } catch (e) {
      // A timeout is expected occasionally and stays quiet; anything else is the
      // only trace of "why did the box find nothing" and is worth a log line.
      const reason = e instanceof UniprotError ? e.reason : 'internal'
      if (reason !== 'timeout' && reason !== 'aborted') {
        console.warn(`[protein-platform] uniprot lookup failed (${reason}): ${query}`)
      }
      return { ok: false, reason: reason as Reason }
    } finally {
      clearTimeout(timer)
      inflight.delete(key)
    }
  })()

  inflight.set(key, run)
  return run
}
