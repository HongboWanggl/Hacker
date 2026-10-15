// The compute-routing tier's failure contract, against a real HTTP worker.
//
// boltz.mjs routes to a GPU worker first (a reverse-SSH tunnel to a home
// machine). That tier is an accelerator, never a dependency, so a worker failure
// has to fall through to the next engine — EXCEPT when the worker actually ran
// the fold and it produced nothing, because then the reason is a property of
// this input and the fall-through has nothing better to say.
//
// This file exists because that distinction was wrong in production: the 920-aa
// androgen receptor (P10275, 2026-10-15) ran on the worker for 686 s, came back
// `502 {"error":"Local Boltz-2 finished but no model_0.pdb found under …"}`, and
// the user was shown "Boltz-2 needs an API key…" — an OOM reported as a setup
// problem. The 502 error must survive to the user; the 503/500/401 shapes must
// still fall through.
//
// A real node:http server stands in for the worker (runWorkerBoltz uses the
// GLOBAL fetch, outside tctx.net), so this also pins the actual status-code
// conventions of worker.mjs, not a mock of them.
import { createServer } from 'node:http'

// Pin the environment BEFORE boltz.mjs is imported: WORKER_URL is captured at
// module load, and the engine probes must not find the real machine's engines
// (this dev box has ~/boltz2/venv beside the platform, and resolveLocalBoltz
// would happily run a real fold).
process.env.HOME = '/tmp/pp-boltz-worker-unit-nohome'
process.env.AGH_HOME = '/tmp/pp-boltz-worker-unit-nohome'
delete process.env.BOLTZ_API_KEY
delete process.env.BOLTZ_LOCAL_BIN
process.env.BOLTZ_WORKER_TOKEN = 'unit-test-token' // fake; never a real credential

type Reply = { status: number; body: string }
type Scenario = { health?: Reply; predict?: Reply }
let scenario: Scenario = {}
let lastAuth: string | undefined
let lastPredictBody = ''

const server = createServer((req, res) => {
  if (req.url === '/health') {
    const r = scenario.health ?? { status: 200, body: '{"ok":true,"bin":true}' }
    res.writeHead(r.status, { 'content-type': 'application/json' })
    res.end(r.body)
    return
  }
  if (req.url === '/predict') {
    let raw = ''
    req.on('data', (c) => {
      raw += c
    })
    req.on('end', () => {
      lastPredictBody = raw
      lastAuth = req.headers.authorization
      const r = scenario.predict ?? { status: 200, body: '{}' }
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(r.body)
    })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"error":"not found"}')
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
const addr = server.address()
if (!addr || typeof addr === 'string') throw new Error('no port')
process.env.BOLTZ_WORKER_URL = `http://127.0.0.1:${addr.port}`

const { predictComplex } = await import('../protein-predictor/boltz.mjs')

type ToolResult = {
  isError?: boolean
  structured?: Record<string, unknown>
  content?: Array<{ text?: string }>
}
type ToolSpec = {
  name: string
  execute: (args: Record<string, unknown>, tctx: unknown) => Promise<ToolResult>
}
const captured: ToolSpec[] = []
predictComplex.apply({ extension: () => ({ registerTool: (t: ToolSpec) => captured.push(t) }) })
const spec = captured.find((t) => t.name === 'predict_complex') as
  | (ToolSpec & { description?: string })
  | undefined
if (!spec) throw new Error('predict_complex not registered')

let failed = 0
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(cond ? 'ok ' : 'FAIL', name, extra)
  if (!cond) {
    failed++
    process.exitCode = 1
  }
}
const textOf = (res: ToolResult) =>
  (res.content ?? []).map((c) => (typeof c.text === 'string' ? c.text : '')).join(' ')

function makeTctx() {
  const written = new Map<string, string>()
  return {
    written,
    net: {
      fetch: async () => {
        throw new Error('network must not be used when no API key is configured')
      },
    },
    fs: { write: async (p: string, data: unknown) => written.set(p, String(data)) },
  }
}

const PDB = [
  'ATOM      1  CA  ALA A   1      11.111  22.222  33.333  1.00 85.00           C',
  'ATOM      2  CA  ALA A   2      12.111  22.222  33.333  1.00 84.00           C',
].join('\n')

// --- 0. the advertised envelope must not outrun the evidence ----------------
// The description is what the agent reads when choosing a tool, so a capability
// claim here becomes a promise to the user. 1000 is the REFUSAL bound; 920 aa
// demonstrably does not fold on the 8 GB worker card.
{
  const d = String(spec.description ?? '')
  ok('description still states the 1000 refusal bound', d.includes('1000'))
  ok('description discloses the measured fold limit', /\b408\b/.test(d) && /actually completed/i.test(d))
  ok('description warns about the memory wall in between', /out of memory/i.test(d))
}
const CONF = { ptm: 0.9, iptm: 0.85 }
// A single chain ≥400 aa is the long-chain fallback predict_complex accepts
// (ESMFold 413s there) — the exact shape that reached the worker in the incident.
const LONG_SINGLE = 'MKTAYIAKQRQISFVKSHFSRQ'.repeat(42) // 924 aa
const PAIR = 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK'

// --- 1. an unreachable worker keeps the old accelerator semantics ------------
scenario = { health: { status: 503, body: '{"error":"down"}' } }
{
  const res = await spec.execute({ sequences: PAIR, name: 'w_health_down' }, makeTctx())
  ok(
    'health 503 → falls through to SETUP_HINT',
    res.isError && textOf(res).includes('needs an API key'),
    textOf(res).slice(0, 120),
  )
}

// --- 2. a health endpoint that says "no CLI here" is not a compute failure ---
scenario = { health: { status: 200, body: '{"ok":true,"bin":false}' } }
{
  const res = await spec.execute({ sequences: PAIR, name: 'w_no_bin' }, makeTctx())
  ok('health bin:false → falls through', res.isError && textOf(res).includes('needs an API key'))
}

// --- 3. THE REGRESSION: a 502 that names the compute outcome is the reason ---
const OOM = 'Local Boltz-2 finished but no model_0.pdb found under /tmp/boltz-local-xUkA46/out'
{
  scenario = { predict: { status: 502, body: JSON.stringify({ error: OOM }) } }
  const res = await spec.execute({ sequences: LONG_SINGLE, name: 'w_oom' }, makeTctx())
  const text = textOf(res)
  ok('502 compute error reaches the user', res.isError && text.includes('no model_0.pdb'), text.slice(0, 140))
  ok('502 compute error is not reported as a setup problem', !text.includes('needs an API key'))
  ok('worker was asked about this chain', lastPredictBody.includes(LONG_SINGLE.slice(0, 40)))
  ok('worker token was sent', lastAuth === 'Bearer unit-test-token', String(lastAuth))
}

// --- 4. 502 with the worker's own `terminal` flag surfaces verbatim ----------
{
  const cap = 'Boltz-2 hit the 20-minute cap on this target; split it into ≤600 aa domains'
  scenario = { predict: { status: 502, body: JSON.stringify({ error: cap, terminal: true }) } }
  const res = await spec.execute({ sequences: PAIR, name: 'w_terminal' }, makeTctx())
  ok(
    '502 terminal → verbatim',
    res.isError && textOf(res).includes('20-minute cap'),
    textOf(res).slice(0, 140),
  )
}

// --- 5. infrastructure statuses stay infrastructure -------------------------
// 503 (no CLI), 500 (crash) and 401 (bad token) say nothing about this input,
// so they must not displace the setup hint that tells the operator what to fix.
const infra: Array<[string, Reply]> = [
  ['503', { status: 503, body: '{"error":"boltz CLI not available on worker"}' }],
  ['500', { status: 500, body: '{"error":"worker crash: ENOENT"}' }],
  ['401', { status: 401, body: '{"error":"bad worker token"}' }],
]
for (const [label, reply] of infra) {
  scenario = { predict: reply }
  const res = await spec.execute({ sequences: PAIR, name: `w_infra_${label}` }, makeTctx())
  ok(`${label} stays infra → SETUP_HINT`, res.isError && textOf(res).includes('needs an API key'))
}

// --- 6. a 502 with a non-JSON body must not fabricate a reason --------------
scenario = { predict: { status: 502, body: '<html>502 Bad Gateway</html>' } }
{
  const res = await spec.execute({ sequences: PAIR, name: 'w_html_502' }, makeTctx())
  ok('502 non-JSON → falls through', res.isError && textOf(res).includes('needs an API key'))
}

// --- 7. a 200 without a model is not a success ------------------------------
scenario = { predict: { status: 200, body: '{}' } }
{
  const res = await spec.execute({ sequences: PAIR, name: 'w_empty_200' }, makeTctx())
  ok('200 without pdb → falls through', res.isError && textOf(res).includes('needs an API key'))
}

// --- 8. the happy path actually runs through the worker ---------------------
{
  scenario = { predict: { status: 200, body: JSON.stringify({ pdb: PDB, conf: CONF, aff: {} }) } }
  const tctx = makeTctx()
  const res = await spec.execute({ sequences: PAIR, name: 'w_ok' }, tctx)
  const r = res.structured ?? {}
  ok('worker fold succeeds', !res.isError && r.engine === 'boltz2-worker', JSON.stringify(r).slice(0, 160))
  ok(
    'worker PDB lands in the workspace',
    String(tctx.written.get('structures/w_ok_boltz_local.pdb')).includes('CA'),
  )
  ok('worker conf scaled to 0-100', r.ptm === 90 && r.iptm === 85, JSON.stringify(r.metrics ?? r))
}

// --- 9. a later tier that CAN run wins over the worker's compute error ------
// The whole point of carrying workerError instead of stopping: an OOM on an 8 GB
// card is exactly what a different engine can absorb.
{
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const fakeBin = '/tmp/pp-boltz-worker-unit-bin/boltz'
  mkdirSync('/tmp/pp-boltz-worker-unit-bin', { recursive: true })
  writeFileSync(
    fakeBin,
    `#!/bin/bash
OUT=""
args=("$@")
for i in \${!args[@]}; do
  if [ "\${args[$i]}" = "--out_dir" ]; then OUT="\${args[$((i+1))]}"; fi
done
mkdir -p "$OUT/predictions/input"
cat > "$OUT/predictions/input/model_0.pdb" <<'PDB'
${PDB}
PDB
echo '{"ptm":0.8,"iptm":0.7}' > "$OUT/predictions/input/confidence_model_0.json"
`,
    { mode: 0o755 },
  )
  process.env.BOLTZ_LOCAL_BIN = fakeBin
  scenario = { predict: { status: 502, body: JSON.stringify({ error: OOM }) } }
  const res = await spec.execute({ sequences: PAIR, name: 'w_fallback_wins' }, makeTctx())
  const r = res.structured ?? {}
  ok(
    'a runnable lower tier wins over the worker error',
    !res.isError && r.engine === 'boltz2-local',
    JSON.stringify(r).slice(0, 160),
  )
  delete process.env.BOLTZ_LOCAL_BIN
}

// --- 10. the no-model local path keeps boltz's own words --------------------
// boltz-2 exits 0 with msa/ and processed/ populated and predictions/ empty; the
// only evidence is its stdout, which used to be thrown away here.
{
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const dir = '/tmp/pp-boltz-worker-unit-bin2'
  const fakeBin = `${dir}/boltz`
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    fakeBin,
    `#!/bin/bash
OUT=""
args=("$@")
for i in \${!args[@]}; do
  if [ "\${args[$i]}" = "--out_dir" ]; then OUT="\${args[$((i+1))]}"; fi
done
mkdir -p "$OUT/msa" "$OUT/processed" "$OUT/predictions"
touch "$OUT/processed/input.a3m"
echo "torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.31 GiB" >&2
echo '{"error":"torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.31 GiB"}'
exit 0
`,
    { mode: 0o755 },
  )
  process.env.BOLTZ_LOCAL_BIN = fakeBin
  scenario = { health: { status: 503, body: '{"error":"down"}' } }

  const short = await spec.execute({ sequences: PAIR, name: 'l_short' }, makeTctx())
  const shortText = textOf(short)
  ok('local no-model names the missing artifact', short.isError && shortText.includes('no model_0.pdb'))
  ok('local no-model keeps boltz stdout', shortText.includes('CUDA out of memory'), shortText.slice(0, 200))
  ok(
    'local no-model admits the accelerator is the likely cause',
    shortText.includes('accelerator memory'),
    shortText.slice(0, 200),
  )
  ok('short target gets no envelope lecture', !shortText.includes('longest fold this platform has completed'))

  const long = await spec.execute({ sequences: LONG_SINGLE, name: 'l_long' }, makeTctx())
  const longText = textOf(long)
  ok(
    'target past the demonstrated envelope is told the measured limit',
    longText.includes('924 residues') && longText.includes('408 aa'),
    longText.slice(-260),
  )
  ok('and is told the way out', /Split the target into domains/.test(longText) && /API key/.test(longText))
  // The same sequence re-run reaches the same wall after the same minutes (ui3
  // probe, 2026-10-15: the agent called predict_complex twice with the identical
  // 920-aa chain). The tool's own words are the strongest place to say so, because
  // they are read before the agent decides to retry.
  ok(
    'and is told not to resubmit the same sequence',
    /Do NOT resubmit this same sequence/.test(longText),
    longText.slice(-200),
  )
  delete process.env.BOLTZ_LOCAL_BIN
}

server.close()
console.log(failed === 0 ? 'BOLTZ WORKER TIER TESTS: PASS' : `BOLTZ WORKER TIER TESTS: ${failed} FAILURES`)
