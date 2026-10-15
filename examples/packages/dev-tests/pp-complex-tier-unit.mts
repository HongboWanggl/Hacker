// The two defects found by the 2026-10-15 Q02388 (2944-aa COL7A1) incident,
// pinned so they cannot come back:
//   1. the Boltz tier used to have no upper length bound — the chain was
//      accepted, shipped to the GPU worker, and died in the MSA step against
//      the 20-minute cap (6 s of CPU across 5 minutes, one open socket);
//   2. the worker's terminal compute failure was swallowed by the
//      "worker is never a dependency" fall-through, so the user got a generic
//      "needs a Boltz API key" hint instead of "split into ≤600 aa domains".
//
// Runs against a fake worker on loopback: no GPU, no network, no daemon.
import { createServer } from 'node:http'

type Mode = 'ok' | 'terminal' | 'crash' | 'no-bin'
let mode: Mode = 'ok'
const workerHits: string[] = []
let predictBodies = 0

const server = createServer(async (req, res) => {
  workerHits.push(req.url ?? '')
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, busy: false, bin: true }))
    return
  }
  if (req.url === '/predict') {
    for await (const _ of req) {
      // drain
    }
    predictBodies++
    if (mode === 'terminal') {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          terminal: true,
          error:
            'Local Boltz-2 timed out after 20 min (TIMEDOUT). This target exceeds what the local weights finish on this machine within the cap — DO NOT retry with the same input.',
        }),
      )
      return
    }
    if (mode === 'crash') {
      // A 502 whose reason describes the fold, not the machine — worker.mjs's
      // compute-failure shape. It is carried as `workerError`, but only as a
      // PREFERENCE: a lower tier that can still run wins.
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'Local Boltz-2 finished but no model_0.pdb found (accelerator OOM)' }))
      return
    }
    if (mode === 'no-bin') {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'boltz CLI not available on worker' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ pdb: PDB, conf: { ptm: 0.9, complex_plddt: 0.85 } }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"error":"not found"}')
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port

// WORKER_URL is captured at module load — point it at the fake before importing.
process.env.BOLTZ_WORKER_URL = `http://127.0.0.1:${port}`
process.env.BOLTZ_API_KEY = 'unit-test-fake-key'
const { predictComplex } = await import('../protein-predictor/boltz.mjs')

const PDB = [
  'ATOM      1  CA  ALA A   1      11.111  22.222  33.333  1.00 85.00           C',
  'ATOM      2  CA  ALA A   2      12.111  22.222  33.333  1.00 84.00           C',
].join('\n')

type Init = { method?: string; headers?: Record<string, string>; body?: string }
type Call = { path: string; init: Init }
type ToolResult = {
  isError?: boolean
  structured?: Record<string, unknown>
  content?: Array<{ type?: string; text?: unknown }>
}
type ToolSpec = { name: string; execute: (a: Record<string, unknown>, tctx: unknown) => Promise<ToolResult> }
const captured: ToolSpec[] = []
predictComplex.apply({ extension: () => ({ registerTool: (t: ToolSpec) => captured.push(t) }) })
const spec = captured.find((t) => t.name === 'predict_complex')
if (!spec) throw new Error('predict_complex not registered')

let failures = 0
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(cond ? 'ok ' : 'FAIL', name, extra)
  if (!cond) failures++
}
const textOf = (r: ToolResult) => String(r.content?.[0]?.text ?? '')
// The API chain is only reachable through the mocked tctx.net.fetch; recording
// calls is how we prove a case did (or did not) fall through to it.
const makeTctx = (calls: Call[]) => ({
  net: {
    fetch: async (url: string, init: Init = {}) => {
      calls.push({ path: url.replace(/^https?:\/\/[^/]+/, ''), init })
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'pred_x', status: 'pending' }),
        text: async () => JSON.stringify({ id: 'pred_x', status: 'pending' }),
      }
    },
  },
  fs: { write: async () => {} },
})

const LONG = 'MKTAYIAKQRQISFVKSHFSRQ'.repeat(147).slice(0, 2944) // 2944 aa, the real Q02388 length
ok('fixture is 2944 residues', LONG.length === 2944, String(LONG.length))

// --- 1. over the ceiling: refused in-process, before any routing -------------
{
  mode = 'ok'
  const hitsBefore = workerHits.length
  const calls: Call[] = []
  const res = await spec.execute({ sequences: LONG, name: 'col7a1' }, makeTctx(calls))
  const t = textOf(res)
  ok('2944 aa is refused', res.isError === true)
  ok('refusal states the ceiling', t.includes('1000'), t.slice(0, 120))
  ok('refusal suggests domain splitting', /Split the target into domains/.test(t))
  ok('refusal names the real bottleneck', /MSA/.test(t))
  ok('no API call made', calls.length === 0, `${calls.length}`)
  ok('worker never contacted', workerHits.length === hitsBefore)
}

// --- 2. the ceiling is on the total across chains, not per chain ------------
{
  const calls: Call[] = []
  const res = await spec.execute(
    { sequences: `${LONG.slice(0, 700)},${LONG.slice(0, 700)}`, name: 'pair' },
    makeTctx(calls),
  )
  ok('two 700-aa chains (1400 total) refused', res.isError === true, textOf(res).slice(0, 80))
  ok('multi-chain refusal makes no API call', calls.length === 0)
}

// --- 3. just under the ceiling still routes (the guard is not a blanket ban) -
{
  mode = 'ok'
  const calls: Call[] = []
  const res = await spec.execute({ sequences: LONG.slice(0, 1000), name: 'at-cap' }, makeTctx(calls))
  ok('1000 aa is accepted and routed to the worker', res.isError !== true && !!res.structured)
  ok('worker served the at-cap job', predictBodies >= 1, `predict calls=${predictBodies}`)
}

// --- 4. a terminal worker failure is surfaced, not silently retried ---------
{
  mode = 'terminal'
  const calls: Call[] = []
  const res = await spec.execute({ sequences: LONG.slice(0, 600), name: 'terminal' }, makeTctx(calls))
  const t = textOf(res)
  ok('terminal worker error becomes the failure', res.isError === true)
  ok('the worker reason reaches the user', /DO NOT retry with the same input/.test(t), t.slice(0, 140))
  ok('terminal error does NOT fall through to the API', calls.length === 0, `${calls.length}`)
}

// --- 5. worker failures still fall through (worker ≠ dependency) ------------
// Two shapes, and both must let a configured API key do the work: a 502 that
// describes the fold (carried as a preference, not a verdict) and a 503 that
// describes the machine. Only when NOTHING below can run does the 502 become the
// answer — that last half lives in pp-boltz-worker-unit.mts, which has no key.
{
  mode = 'crash'
  const calls: Call[] = []
  // wait:false keeps the mock to a single submit call — the mocked API always
  // answers "pending", so a polling run would never terminate.
  const res = await spec.execute(
    { sequences: LONG.slice(0, 600), name: 'crash', wait: false },
    makeTctx(calls),
  )
  ok('worker 502 compute error falls through to the API chain', calls.length > 0, `${calls.length}`)
  ok('fall-through still returns a submit result', res.isError !== true && !!res.structured)
}
{
  mode = 'no-bin'
  const calls: Call[] = []
  const res = await spec.execute(
    { sequences: LONG.slice(0, 600), name: 'no-bin', wait: false },
    makeTctx(calls),
  )
  ok('worker 503 (no CLI) falls through to the API chain', calls.length > 0, `${calls.length}`)
  ok('503 fall-through still returns a submit result', res.isError !== true && !!res.structured)
}

server.close()
console.log(failures === 0 ? 'complex-tier probe: PASS' : `complex-tier probe: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
