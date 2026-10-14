import type { DaemonLink } from './agnes.ts'
import { bffCall } from './bff.ts'
import { buildPrompt } from './prompts.ts'

// Turning a description ("人类血红蛋白 α 链") into a shortlist of accessions, for
// the home-page candidate panel.
//
// Two stages, in this order:
//   1. GET api/uniprot — our own server queries UniProt (the browser cannot: the
//      Surface CSP is connect-src 'self'). Sub-second, no task, no archive.
//   2. Only when that finds nothing — which is *always* the case for a Chinese
//      description, since UniProt does not index CJK prose — one hidden agent turn
//      rewrites the description into UniProt syntax and searches again.
//
// Stage 2 exists so the platform can understand a sentence, not so it can leave a
// trace: it creates no task row and archives nothing. What it does leave behind is a
// session in the daemon (cancelled and archived immediately, invisible to the UI) and
// reports/search_*.json inside the scratch workspace — see the package README.

export type CandidateHit = {
  accession: string
  id?: string
  proteinName?: string
  organism?: string
  length?: number
}

export type LookupPhase = 'fast' | 'agent' | 'reading'

export type LookupFailure =
  | 'no-hits' // upstream answered, nothing matched (both stages)
  | 'timeout' // the fallback turn outlived its budget
  | 'cancelled' // the user walked away
  | 'http' // UniProt returned an error status
  | 'network' // we could not reach UniProt at all
  | 'internal'

export type LookupResult =
  | { ok: true; source: 'fast' | 'agent'; query: string; hits: CandidateHit[]; total?: number }
  | { ok: false; reason: LookupFailure; query: string; detail?: string }

const DEFAULT_LIMIT = 8
const AGENT_TIMEOUT_MS = 45_000

/** The fallback turn outlived its budget — its own story, not "no such protein". */
class LookupTimeout extends Error {
  constructor() {
    super(`lookup exceeded ${AGENT_TIMEOUT_MS / 1000}s`)
    this.name = 'LookupTimeout'
  }
}

// One scratch workspace for every fallback, shared by all users of this deployment.
// The daemon derives a session's identity from its key, defaults that key to a hash of
// the cwd, and *resumes* an existing session when the key repeats — so a second lookup
// in the same directory would replay the first one's journal instead of searching.
// A unique session key per lookup is what makes the shared directory safe.
const LOOKUP_DIR = '_lookup'

function uniqueSessionKey(): string {
  // crypto.randomUUID is unavailable on the plain-http public endpoint (secure
  // context only), so the fallback is load-bearing, not a formality.
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined
  const rnd = c?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
  return `pp-lookup-${rnd}`
}

function platformUrl(path: string): URL {
  const base = location.href.split('#')[0]
  return new URL(path, base.endsWith('/') ? base : `${base}/`)
}

// ---------------------------------------------------------------------------
// Stage 1 — our server's proxy. Never throws: a failure here means "try the agent",
// not "tell the user the platform is broken".
async function fastLookup(query: string, limit: number, signal?: AbortSignal): Promise<LookupResult> {
  try {
    const r = await fetch(
      platformUrl(`api/uniprot?q=${encodeURIComponent(query)}&limit=${limit}`),
      signal ? { signal } : {},
    )
    if (!r.ok) return { ok: false, reason: 'http', query }
    const body = (await r.json()) as {
      ok?: boolean
      hits?: CandidateHit[]
      total?: number
      reason?: LookupFailure
    }
    if (!body?.ok || !Array.isArray(body.hits)) {
      return { ok: false, reason: body?.reason ?? 'internal', query }
    }
    return { ok: true, source: 'fast', query, hits: body.hits, total: body.total }
  } catch {
    return { ok: false, reason: signal?.aborted ? 'cancelled' : 'network', query }
  }
}

// ---------------------------------------------------------------------------
function ledgerOf(row: unknown): { kind?: string; data: Record<string, unknown> } {
  const env = (row as { event?: unknown })?.event ?? row
  const data = ((env as { data?: Record<string, unknown> }).data ?? env) as Record<string, unknown>
  const kind = (env as { type?: string; kind?: string })?.type ?? (env as { kind?: string })?.kind
  return { kind, data }
}

function safeJson(text: string): { hits?: CandidateHit[] } | null {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? (v as { hits?: CandidateHit[] }) : null
  } catch {
    return null
  }
}

/** The tool result is the report — unless the transcript clipped it, in which case the
 *  payload's leading `savedTo` (deliberately first, see uniprot.mjs) points at the
 *  full copy in the workspace. */
async function hitsFromResult(
  text: string,
  sessionId: string,
  phase: (p: LookupPhase) => void,
): Promise<CandidateHit[]> {
  const parsed = safeJson(text)
  if (Array.isArray(parsed?.hits)) return parsed.hits
  const m = /"savedTo"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)
  const path = m?.[1].replace(/\\(.)/g, '$1')
  if (!path?.endsWith('.json')) return []
  phase('reading')
  const report = (await bffCall(sessionId, 'protein.report', { path })) as { hits?: CandidateHit[] } | null
  return Array.isArray(report?.hits) ? report.hits : []
}

// Stage 2 — one agent turn in a throwaway session. Returns [] when the agent found
// nothing; throws only when the session itself could not run.
async function agentLookup(
  cfg: { tasksRoot: string },
  sdk: DaemonLink,
  query: string,
  opts: { signal?: AbortSignal; phase: (p: LookupPhase) => void },
): Promise<CandidateHit[]> {
  const r = await fetch(platformUrl('api/task'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: LOOKUP_DIR }),
  })
  if (!r.ok) throw new Error(`lookup dir: HTTP ${r.status}`)

  const cwd = `${cfg.tasksRoot}/${LOOKUP_DIR}`
  const session = await sdk.withClient(async (c) => {
    await c.workspace.add(cwd)
    return await c.session.new({ cwd, preset: 'standard', sessionKey: uniqueSessionKey() })
  })

  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, AGENT_TIMEOUT_MS)
  const onOuterAbort = () => ctrl.abort()
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })

  try {
    // Same auto-approval the task runner installs: a non-chat UI must never
    // dead-end on an approval prompt it cannot show.
    session.onPermissionRequest((req: { requestId?: string; id?: string; options?: unknown[] }) => {
      const options = (req?.options ?? []) as Array<{ kind?: string; optionId?: string }>
      const allow = options.find((o) => /allow|proceed|approve/i.test(o?.kind ?? o?.optionId ?? ''))
      if (allow)
        void session
          .answer({
            requestId: req.requestId ?? req.id,
            response: { optionId: allow.optionId ?? allow.kind },
          })
          .catch(() => {})
    })

    let settle: (v: { text: string } | null) => void = () => {}
    const captured = new Promise<{ text: string } | null>((resolve) => {
      settle = resolve
    })
    void (async () => {
      let lastCall = ''
      try {
        for await (const row of session.events({ preview: true })) {
          const { kind, data } = ledgerOf(row)
          if (kind === 'tool/call') {
            lastCall = String(data.name ?? '')
            continue
          }
          if (kind === 'tool/result') {
            // tool/result rows do not always carry the tool name — the call they
            // answer does.
            if (String(data.name ?? lastCall) !== 'uniprot_search') continue
            const text = (data.content as Array<{ text?: string }> | undefined)?.[0]?.text
            if (data.isError) {
              console.warn('[platform] lookup search failed:', String(text ?? '').slice(0, 200))
              settle(null)
            } else if (typeof text === 'string') {
              settle({ text })
            }
            return
          }
          // A turn that ends without the tool result means the agent never searched.
          if (kind === 'turn/end') {
            settle(null)
            return
          }
        }
        settle(null)
      } catch {
        settle(null)
      }
    })()

    const prompt = session.prompt(buildPrompt('search', { query }), { signal: ctrl.signal })
    // Raced, not awaited: the moment the tool result lands we have everything the
    // panel needs, and the agent's closing sentence is worth nothing.
    const settled = await Promise.race([
      captured,
      prompt.then(
        () => ({ text: '' }),
        () => null,
      ),
    ])
    if (!settled?.text) {
      if (timedOut) throw new LookupTimeout()
      return []
    }
    return await hitsFromResult(settled.text, session.id, opts.phase)
  } finally {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
    // Nothing to keep: the hits are read, so stop the turn and hide the session.
    void session.cancel().catch(() => {})
    const id = session.id
    void sdk.withClient((c) => c.session.archive(id, true)).catch(() => {})
  }
}

// ---------------------------------------------------------------------------
/**
 * Description (or keyword) in, shortlist out. Never throws, never leaves a task row
 * or an archive behind; failures come back as a `reason` the UI turns into a sentence.
 */
export async function lookupCandidates(
  cfg: { tasksRoot: string },
  sdk: DaemonLink,
  query: string,
  opts: { signal?: AbortSignal; limit?: number; onPhase?: (p: LookupPhase) => void } = {},
): Promise<LookupResult> {
  const q = query.trim()
  const limit = opts.limit ?? DEFAULT_LIMIT
  const phase = opts.onPhase ?? (() => {})
  const cancelled = (): LookupResult => ({ ok: false, reason: 'cancelled', query: q })
  if (!q) return { ok: false, reason: 'no-hits', query: q }
  if (opts.signal?.aborted) return cancelled()

  phase('fast')
  const fast = await fastLookup(q, limit, opts.signal)
  if (fast.ok && fast.hits.length) return fast
  if (opts.signal?.aborted) return cancelled()

  phase('agent')
  try {
    const hits = await agentLookup(cfg, sdk, q, { signal: opts.signal, phase })
    if (hits.length) return { ok: true, source: 'agent', query: q, hits }
    // Neither stage matched. A fast-stage failure is the more useful story: "the
    // upstream service is unreachable" beats "no such protein".
    return { ok: false, reason: fast.ok ? 'no-hits' : fast.reason, query: q }
  } catch (e) {
    if (opts.signal?.aborted) return cancelled()
    if (e instanceof LookupTimeout) return { ok: false, reason: 'timeout', query: q }
    return {
      ok: false,
      reason: fast.ok ? 'no-hits' : fast.reason,
      query: q,
      detail: (e as Error)?.message,
    }
  }
}
