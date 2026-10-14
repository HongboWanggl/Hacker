// UniProtKB keyword search, shared by two callers with different network policy:
//   - the agent tool `uniprot_search` (index.mjs), which goes through the sandboxed
//     net service and retries transient upstream failures;
//   - the platform server's GET /api/uniprot route, which uses plain fetch, a hard
//     8s timeout and no retry (it backs a type-ahead, so latency beats completeness).
// Network access is therefore injected as `fetchFn` and nothing here reaches out on
// its own.
//
// NOTE: this file ships inside the protein-predictor package, which is published as
// a self-contained directory — so it must not import from the other example packages.

export const UNIPROT_BASE = 'https://rest.uniprot.org/uniprotkb'
// The five TSV columns the candidate table renders. Unchanged since the tool existed.
export const TSV_FIELDS = 'accession,id,protein_name,organism_name,length'
// Belt and braces: `size` already bounds the response, but a search that ignores it
// must not be able to hand a megabyte of TSV to the parser (or to the browser).
const MAX_TSV_CHARS = 256 * 1024

/** Raised for every upstream problem, so callers can map `reason` to their own UI. */
export class UniprotError extends Error {
  constructor(reason, status) {
    super(`uniprot ${reason}${status ? ` HTTP ${status}` : ''}`)
    this.name = 'UniprotError'
    this.reason = reason // 'http' | 'network' | 'timeout' | 'aborted' | 'internal'
    this.status = status
  }
}

/** UniProt accepts at most 25 rows per page; below 1 is meaningless. */
export function normalizeLimit(limit, fallback = 8) {
  const n = Math.floor(Number(limit))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(25, n)
}

export function buildSearchUrl({ query, limit = 8, base = UNIPROT_BASE }) {
  return `${base}/search?query=${encodeURIComponent(query)}&format=tsv&fields=${TSV_FIELDS}&size=${limit}`
}

/** TSV body -> hits. Header-only (or empty) body means "no matches", not an error. */
export function parseHits(tsv, limit = 8) {
  const lines = String(tsv ?? '')
    .trim()
    .split('\n')
  if (lines.length <= 1) return []
  return lines.slice(1, 1 + normalizeLimit(limit)).map((l) => {
    const [accession, id, proteinName, organism, length] = l.split('\t')
    return { accession, id, proteinName, organism, length: Number(length) }
  })
}

/**
 * Bias a query toward curated (reviewed) entries: Swiss-Prot rows carry the
 * canonical names a description is most likely about, TrEMBL is full of
 * predicted fragments that crowd the top of a fuzzy search. Applied only when
 * the user's query does not already constrain reviewedness.
 */
export function preferReviewed(query) {
  const q = String(query ?? '').trim()
  if (!q || /\breviewed\s*:/i.test(q)) return q
  return `(${q}) AND (reviewed:true)`
}

/** Filename-safe stem for reports/search_<slug>.json. */
export function slugForQuery(query) {
  return (
    String(query ?? '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'query'
  )
}

// One retry after a short backoff for transient upstream failures — the free
// shared ESMFold/UniProt endpoints occasionally return 5xx or drop connections.
// Retries network errors and 5xx/429 only; a 4xx (bad accession, bad sequence)
// fails immediately. The second attempt's result (or error) is returned as-is.
// An abort is never retried: the caller asked us to stop.
export async function fetchRetry(fetchFn, url, opts = {}) {
  const aborted = (e) => e?.name === 'AbortError' || e?.name === 'TimeoutError' || opts?.signal?.aborted
  try {
    const res = await fetchFn(url, opts)
    if (res.status >= 500 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500))
      return fetchFn(url, opts)
    }
    return res
  } catch (e) {
    if (aborted(e)) throw e
    await new Promise((r) => setTimeout(r, 1500))
    return fetchFn(url, opts)
  }
}

function totalFrom(res) {
  const raw = res?.headers?.get?.('x-total-results')
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

/**
 * One page of hits. Throws UniprotError on any failure — never returns a partial
 * success, so a caller cannot mistake "upstream is down" for "no such protein".
 *
 * @param fetchFn  fetch-compatible function; extra options (e.g. timeoutMs for the
 *                 sandboxed net service) go in `fetchOpts` and are passed through.
 * @param signal   optional AbortSignal; forwarding it is opt-in because not every
 *                 fetchFn implementation accepts one.
 */
export async function searchUniprot(
  fetchFn,
  { query, limit = 8, base = UNIPROT_BASE, retry = false, signal, fetchOpts = {} } = {},
) {
  const url = buildSearchUrl({ query, limit: normalizeLimit(limit), base })
  const opts = signal ? { ...fetchOpts, signal } : { ...fetchOpts }
  let res
  try {
    res = retry ? await fetchRetry(fetchFn, url, opts) : await fetchFn(url, opts)
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new UniprotError('timeout')
    if (signal?.aborted || e?.name === 'AbortError') throw new UniprotError('aborted')
    throw new UniprotError('network')
  }
  if (!res?.ok) throw new UniprotError('http', res?.status)
  let body = await res.text()
  if (body.length > MAX_TSV_CHARS) body = body.slice(0, MAX_TSV_CHARS)
  return { hits: parseHits(body, limit), total: totalFrom(res) }
}

/**
 * The type-ahead path: try the reviewed-biased query first, fall back to the raw
 * one when it comes up empty (many perfectly ordinary descriptions only exist in
 * TrEMBL). Either way the caller gets the query the user actually typed.
 */
export async function searchUniprotPreferred(fetchFn, opts = {}) {
  const reviewed = preferReviewed(opts.query)
  if (reviewed !== opts.query) {
    const first = await searchUniprot(fetchFn, { ...opts, query: reviewed })
    if (first.hits.length) return { ...first, query: opts.query }
  }
  return { ...(await searchUniprot(fetchFn, opts)), query: opts.query }
}
