// uniprot.mjs unit probe (mocked fetchFn, no network): the shared search module
// behind both the uniprot_search tool and the platform's GET /api/uniprot route.
// The route turns every failure into a typed reason instead of a 500, so the
// classification here is load-bearing: misreporting "network" as "no such protein"
// would show a user an empty candidate list when UniProt is merely down.
import {
  buildSearchUrl,
  parseHits,
  preferReviewed,
  searchUniprot,
  searchUniprotPreferred,
  slugForQuery,
  UniprotError,
} from '../protein-predictor/uniprot.mjs'

let failed = 0
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, cond ? '' : extra)
  if (!cond) failed++
}
const eq = (name: string, got: unknown, want: unknown) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}`)

const TSV = [
  'Entry\tEntry Name\tProtein names\tOrganism\tLength',
  'P69905\tHBA_HUMAN\tHemoglobin subunit alpha\tHomo sapiens (Human)\t142',
  'P68871\tHBB_HUMAN\tHemoglobin subunit beta\tHomo sapiens (Human)\t147',
].join('\n')

const res = (body: string, opts: { status?: number; total?: number } = {}) => ({
  ok: (opts.status ?? 200) < 400,
  status: opts.status ?? 200,
  headers: { get: (k: string) => (k.toLowerCase() === 'x-total-results' ? String(opts.total ?? '') : null) },
  text: async () => body,
})

// --- URL + parsing ---------------------------------------------------------
const url = buildSearchUrl({ query: 'hemoglobin human', limit: 8 })
ok('url encodes query', url.includes('query=hemoglobin%20human'), url)
ok('url asks for the five TSV columns', url.includes('fields=accession,id,protein_name,organism_name,length'))
ok('url carries page size', url.endsWith('&size=8'))

eq('header-only body → no hits', parseHits('Entry\tEntry Name\n'), [])
eq('empty body → no hits', parseHits(''), [])
eq('rows map to {accession,id,proteinName,organism,length}', parseHits(TSV), [
  {
    accession: 'P69905',
    id: 'HBA_HUMAN',
    proteinName: 'Hemoglobin subunit alpha',
    organism: 'Homo sapiens (Human)',
    length: 142,
  },
  {
    accession: 'P68871',
    id: 'HBB_HUMAN',
    proteinName: 'Hemoglobin subunit beta',
    organism: 'Homo sapiens (Human)',
    length: 147,
  },
])
ok('length is numeric, not a string', typeof parseHits(TSV)[0].length === 'number')
ok('limit caps rows even if upstream ignored size', parseHits(TSV, 1).length === 1)

// --- query shaping ---------------------------------------------------------
ok('reviewed bias added', preferReviewed('hemoglobin human') === '(hemoglobin human) AND (reviewed:true)')
ok(
  'existing reviewed clause kept',
  preferReviewed('hemoglobin AND reviewed:true') === 'hemoglobin AND reviewed:true',
)
ok('empty query stays empty', preferReviewed('   ') === '')
eq('slug strips CJK to the fallback stem', slugForQuery('人类血红蛋白 α 链'), 'query')
ok('slug is filename-safe and capped', slugForQuery('a/../b'.repeat(30)).length <= 60)

// --- failure classification (what the route reports to the browser) ---------
const thrown = async (p: Promise<unknown>) => {
  try {
    await p
    return null
  } catch (e) {
    return e as UniprotError
  }
}
let calls = 0
const http500 = async () => {
  calls++
  return res('', { status: 500 })
}
const e500 = await thrown(searchUniprot(http500, { query: 'x', limit: 3 }))
ok(
  '5xx without retry → http/500 in one call',
  calls === 1 && e500?.reason === 'http' && e500?.status === 500,
  `${calls} ${e500?.reason}`,
)

calls = 0
await thrown(searchUniprot(http500, { query: 'x', limit: 3, retry: true }))
ok('5xx with retry → two calls (retry policy still intact via this module)', calls === 2, `${calls}`)

calls = 0
const netDown = async () => {
  calls++
  throw new Error('ECONNRESET')
}
const eNet = await thrown(searchUniprot(netDown, { query: 'x', limit: 3 }))
ok(
  'network throw → reason network, not retried',
  calls === 1 && eNet?.reason === 'network',
  `${calls} ${eNet?.reason}`,
)

calls = 0
const timingOut = async () => {
  calls++
  const e = new Error('timed out')
  e.name = 'TimeoutError'
  throw e
}
ok(
  'timeout is its own reason',
  (await thrown(searchUniprot(timingOut, { query: 'x', limit: 3 })))?.reason === 'timeout',
)

calls = 0
const aborting = async (u: string, o: { signal?: AbortSignal } = {}) => {
  calls++
  if (o.signal?.aborted) {
    const e = new Error('aborted')
    e.name = 'AbortError'
    throw e
  }
  return res(TSV)
}
const pre = AbortSignal.abort()
ok(
  'pre-aborted signal → reason aborted',
  (await thrown(searchUniprot(aborting, { query: 'x', signal: pre })))?.reason === 'aborted',
)
ok('aborted call never retried', calls === 1, `${calls}`)

// --- success shape + query fallback ----------------------------------------
let seenUrl = ''
const good = async (u: string) => {
  seenUrl = u
  return res(TSV, { total: 4321 })
}
const hit = await searchUniprot(good, { query: 'hemoglobin human', limit: 5 })
ok('success returns hits + total', hit.hits.length === 2 && hit.total === 4321, JSON.stringify(hit))
ok(
  'success hits the documented endpoint',
  seenUrl.startsWith('https://rest.uniprot.org/uniprotkb/search?'),
  seenUrl,
)

const queries: string[] = []
const reviewedEmpty = async (u: string) => {
  queries.push(decodeURIComponent(u.match(/query=([^&]*)/)?.[1] ?? ''))
  return res(queries.length === 1 ? 'Entry\tEntry Name\n' : TSV)
}
const fb = await searchUniprotPreferred(reviewedEmpty, { query: 'hemoglobin human', limit: 5 })
eq('reviewed-first, then the raw query', queries, [
  '(hemoglobin human) AND (reviewed:true)',
  'hemoglobin human',
])
ok(
  'fallback returns hits under the query the user typed',
  fb.hits.length === 2 && fb.query === 'hemoglobin human',
  JSON.stringify(fb.query),
)

const only: string[] = []
const reviewedHit = async (u: string) => {
  only.push(decodeURIComponent(u.match(/query=([^&]*)/)?.[1] ?? ''))
  return res(TSV)
}
await searchUniprotPreferred(reviewedHit, { query: 'hemoglobin human', limit: 5 })
ok('a reviewed hit costs exactly one request', only.length === 1, `${only.length}`)

console.log(failed ? `FAILED: ${failed}` : 'pp-lookup-unit: PASS')
process.exitCode = failed ? 1 : 0
