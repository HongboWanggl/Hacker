// predict_complex full job lifecycle against a mocked Boltz API — the only
// executable coverage of the submit → poll → download → metrics path (the real
// API needs a paid key). Covers: wait=false submit, bearer→x-api-key fallback,
// success parsing (metrics scaled to 0-100, verdict), failed-job surfacing,
// and the "complexes only" guard.
import { mkdirSync, writeFileSync } from 'node:fs'

// Isolate from the compute-routing tier: runWorkerBoltz probes BOLTZ_WORKER_URL
// with the GLOBAL fetch (outside the tctx.net mock), and on a dev box with a
// live worker tunnel (127.0.0.1:7610) the test would silently run real GPU
// predictions. Pin the worker to a dead loopback port BEFORE importing
// boltz.mjs (WORKER_URL is captured at module load) — connection-refused is
// instant, and the fall-through to the API chain is exactly what this file
// mocks and asserts.
process.env.BOLTZ_WORKER_URL = 'http://127.0.0.1:9'
const { predictComplex } = await import('../protein-predictor/boltz.mjs')

// Structural types for the mocked tool surface (tsx strips these; they exist
// so `biome check` passes without any-casts on dev-test stubs).
type Init = { method?: string; headers?: Record<string, string>; body?: string }
type Call = { path: string; init: Init }
type Respond = {
  ok: boolean
  status: number
  json?: () => Promise<unknown>
  text?: () => Promise<string>
}
type Structured = {
  predictionId?: string
  savedTo?: string
  chains?: number
  hasLigand?: boolean
  residues?: number
  structureConfidence?: number
  bindingConfidence?: number
  iptm?: number
  ligandIptm?: number
  proteinIptm?: number
  verdict?: string
  timedOut?: boolean
  note?: string
}
type ToolResult = {
  isError?: boolean
  structured?: Structured
  content?: Array<{ text?: string | { message?: string } }>
}
type ToolSpec = {
  name: string
  execute: (args: Record<string, unknown>, tctx: unknown) => Promise<ToolResult>
}
const captured: ToolSpec[] = []
predictComplex.apply({ extension: () => ({ registerTool: (t: ToolSpec) => captured.push(t) }) })
const spec = captured.find((t) => t.name === 'predict_complex')
if (!spec) throw new Error('predict_complex not registered')

process.env.BOLTZ_API_KEY = 'unit-test-fake-key' // fake; never a real credential
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(cond ? 'ok ' : 'FAIL', name, extra)
  if (!cond) process.exitCode = 1
}

const PDB = [
  'ATOM      1  CA  ALA A   1      11.111  22.222  33.333  1.00 85.00           C',
  'ATOM      2  CA  ALA A   2      12.111  22.222  33.333  1.00 84.00           C',
  'ATOM      3  CA  GLY A   3      13.111  22.222  33.333  1.00 70.00           C',
  'ATOM      4  CA  GLY B   4      14.111  22.222  33.333  1.00 90.00           C',
].join('\n')

function makeTctx(calls: Call[], responder: (path: string, init: Init) => Respond) {
  const written = new Map<string, string>()
  return {
    calls,
    written,
    net: {
      fetch: async (url: string, init: Init = {}) => {
        const path = url.replace('https://api.boltz.bio', '').replace(/^https?:\/\/[^/]+/, '')
        calls.push({ path, init })
        return responder(path, init)
      },
    },
    fs: { write: async (p: string, data: unknown) => written.set(p, String(data)) },
  }
}
const jsonRes = (obj: Record<string, unknown>, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => obj,
  text: async () => JSON.stringify(obj),
})

// --- 1. wait=false: submit only, no polling
{
  const calls: Call[] = []
  const tctx = makeTctx(calls, () => jsonRes({ id: 'pred_1', status: 'pending' }))
  const res = await spec.execute(
    { sequences: 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK', wait: false },
    tctx,
  )
  ok('submit-only returns prediction id', res.structured?.predictionId === 'pred_1')
  ok('submit-only makes exactly 1 call', calls.length === 1)
  ok(
    'bearer auth on submit',
    String(calls[0]?.init?.headers?.Authorization ?? '').startsWith('Bearer unit-test-fake-key'),
  )
  ok(
    'request is boltz-2.1 with two protein entities',
    JSON.parse(calls[0].init.body).model === 'boltz-2.1' &&
      JSON.parse(calls[0].init.body).input.entities.length === 2,
  )
}

// --- 2. full success: poll (already-terminal) → download → parse
{
  const calls: Call[] = []
  const tctx = makeTctx(calls, (path) => {
    if (path === '/compute/v1/predictions/structure-and-binding')
      return jsonRes({ id: 'pred_2', status: 'pending' })
    if (path.startsWith('/compute/v1/predictions/structure-and-binding/pred_2')) {
      return jsonRes({
        status: 'succeeded',
        metrics: {
          structure_confidence: 0.842,
          ptm: 0.881,
          iptm: 0.825,
          ligand_iptm: 0.799,
          binding_confidence: 0.873,
        },
        outputs: { structures: [{ url: 'https://files.example/pred_2_best.pdb' }] },
      })
    }
    if (path.includes('pred_2_best.pdb')) return { ok: true, status: 200, text: async () => PDB }
    return jsonRes({ error: { message: `unexpected ${path}` } }, 404)
  })
  const res = await spec.execute(
    {
      sequences: 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK',
      ligand_smiles: 'CC(=O)OC1=CC=CC=C1C(=O)O',
      name: 'mock pair',
    },
    tctx,
  )
  const r = res.structured ?? {}
  ok('success not error', !res.isError)
  ok(
    'pdb saved to workspace',
    r.savedTo === 'structures/mock_pair_boltz.pdb' &&
      (tctx.written.get('structures/mock_pair_boltz.pdb') ?? '').startsWith('ATOM'),
  )
  ok('chains + ligand reported', r.chains === 2 && r.hasLigand === true)
  ok('residue count from CA lines', r.residues === 4)
  ok(
    'metrics scaled to 0-100',
    r.structureConfidence === 84.2 &&
      r.bindingConfidence === 87.3 &&
      r.iptm === 82.5 &&
      r.ligandIptm === 79.9,
  )
  ok('high-confidence verdict', r.verdict === 'predicted to bind with high confidence')
  ok('ligand gets next chain id', JSON.parse(calls[0].init.body).input.entities[2]?.chain_ids?.[0] === 'C')
}

// Fake npz bytes for PAE-pickup mocks: only shape matters to the tool (it
// persists whatever it downloads); the service decodes real matrices.
const NPZ = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02, 0x03, 0xff, 0xfe])

// --- 2b. API mode: PAE npz listed FIRST → structure still picked correctly,
//         pae downloaded and persisted (paePath in report)
{
  const calls: Call[] = []
  const tctx = makeTctx(calls, (path) => {
    if (path === '/compute/v1/predictions/structure-and-binding')
      return jsonRes({ id: 'pred_2b', status: 'pending' })
    if (path.startsWith('/compute/v1/predictions/structure-and-binding/pred_2b')) {
      return jsonRes({
        status: 'succeeded',
        metrics: { ptm: 0.9, iptm: 0.85 },
        outputs: {
          structures: [
            { url: 'https://files.example/pred_2b_pae.npz' },
            { url: 'https://files.example/pred_2b_model.pdb' },
          ],
        },
      })
    }
    if (path.includes('pred_2b_pae.npz'))
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => NPZ.buffer.slice(NPZ.byteOffset, NPZ.byteOffset + NPZ.byteLength),
      }
    if (path.includes('pred_2b_model.pdb')) return { ok: true, status: 200, text: async () => PDB }
    return jsonRes({ error: { message: `unexpected ${path}` } }, 404)
  })
  const res = await spec.execute(
    { sequences: 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK', name: 'mock pae' },
    tctx,
  )
  const r = res.structured ?? {}
  ok('pae-first list still saves the PDB', r.savedTo === 'structures/mock_pae_boltz.pdb' && !res.isError)
  ok('paePath reported', typeof r.paePath === 'string' && r.paePath.startsWith('structures/mock_pae_pae.npz'))
  const saved = tctx.written.get(String(r.paePath))
  ok('npz bytes persisted', saved !== undefined && saved.length === NPZ.length)
}

// --- 2c. API mode: no PAE entry → report identical, no paePath, no crash
{
  const calls: Call[] = []
  const tctx = makeTctx(calls, (path) => {
    if (path === '/compute/v1/predictions/structure-and-binding')
      return jsonRes({ id: 'pred_2c', status: 'pending' })
    if (path.startsWith('/compute/v1/predictions/structure-and-binding/pred_2c')) {
      return jsonRes({
        status: 'succeeded',
        metrics: { ptm: 0.9, iptm: 0.85 },
        outputs: { structures: [{ url: 'https://files.example/pred_2c_model.pdb' }] },
      })
    }
    if (path.includes('pred_2c_model.pdb')) return { ok: true, status: 200, text: async () => PDB }
    return jsonRes({ error: { message: `unexpected ${path}` } }, 404)
  })
  const res = await spec.execute(
    { sequences: 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK', name: 'mock nopae' },
    tctx,
  )
  ok('no pae entry → no paePath', !res.isError && res.structured?.paePath === undefined)
}

// --- 2d. API mode: pae download HTTP-fails → prediction still succeeds
{
  const calls: Call[] = []
  const tctx = makeTctx(calls, (path) => {
    if (path === '/compute/v1/predictions/structure-and-binding')
      return jsonRes({ id: 'pred_2d', status: 'pending' })
    if (path.startsWith('/compute/v1/predictions/structure-and-binding/pred_2d')) {
      return jsonRes({
        status: 'succeeded',
        metrics: { ptm: 0.9, iptm: 0.85 },
        outputs: {
          structures: [
            { url: 'https://files.example/pred_2d_pae.npz' },
            { url: 'https://files.example/pred_2d_model.pdb' },
          ],
        },
      })
    }
    if (path.includes('pred_2d_pae.npz')) return { ok: false, status: 403 }
    if (path.includes('pred_2d_model.pdb')) return { ok: true, status: 200, text: async () => PDB }
    return jsonRes({ error: { message: `unexpected ${path}` } }, 404)
  })
  const res = await spec.execute(
    { sequences: 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK', name: 'mock paefail' },
    tctx,
  )
  ok('pae download failure is not fatal', !res.isError && res.structured?.paePath === undefined)
}

// --- 2e. canonical npz name blocked (stale-file overwrite) → falls back to a
//         time-suffixed fresh path
{
  const calls: Call[] = []
  const base = makeTctx(calls, (path) => {
    if (path === '/compute/v1/predictions/structure-and-binding')
      return jsonRes({ id: 'pred_2e', status: 'pending' })
    if (path.startsWith('/compute/v1/predictions/structure-and-binding/pred_2e')) {
      return jsonRes({
        status: 'succeeded',
        metrics: { ptm: 0.9, iptm: 0.85 },
        outputs: {
          structures: [
            { url: 'https://files.example/pred_2e_pae.npz' },
            { url: 'https://files.example/pred_2e_model.pdb' },
          ],
        },
      })
    }
    if (path.includes('pred_2e_pae.npz'))
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => NPZ.buffer.slice(NPZ.byteOffset, NPZ.byteOffset + NPZ.byteLength),
      }
    if (path.includes('pred_2e_model.pdb')) return { ok: true, status: 200, text: async () => PDB }
    return jsonRes({ error: { message: `unexpected ${path}` } }, 404)
  })
  const tctx = {
    ...base,
    fs: {
      write: async (p: string, data: unknown) => {
        // The canonical npz name is stale on disk (binary overwrite refused);
        // every other path writes through.
        if (p === 'structures/mock_stale_pae.npz') {
          throw new Error('E_SEAM_MISSING: checkpoint unavailable: E_CHECKPOINT_UNRESTORABLE')
        }
        base.written.set(p, String(data))
      },
    },
  }
  const res = await spec.execute(
    { sequences: 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK', name: 'mock stale' },
    tctx,
  )
  const r = res.structured ?? {}
  ok(
    'stale canonical name → suffixed fallback',
    typeof r.paePath === 'string' && /_\d{13}_pae\.npz$/.test(String(r.paePath)),
  )
  ok('suffixed npz persisted', tctx.written.get(String(r.paePath)) !== undefined)
}

// --- 3. bearer 401 → x-api-key fallback still succeeds
{
  const calls: Call[] = []
  const tctx = makeTctx(calls, (path, init) => {
    if (path === '/compute/v1/predictions/structure-and-binding')
      return jsonRes({ id: 'pred_3', status: 'pending' })
    if (init.headers?.Authorization) return jsonRes({ error: { message: 'unauthorized' } }, 401)
    if (path.startsWith('/compute/v1/predictions/structure-and-binding/pred_3')) {
      return jsonRes({
        status: 'succeeded',
        metrics: { ptm: 0.7, iptm: 0.55 },
        outputs: { structures: [{ url: 'https://files.example/p3.pdb' }] },
      })
    }
    return { ok: true, status: 200, text: async () => PDB }
  })
  const res = await spec.execute({ sequences: 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK' }, tctx)
  ok('x-api-key fallback used', !res.isError && calls.some((c) => c.init.headers?.['x-api-key']))
  ok(
    'iptm-only verdict path',
    res.structured?.verdict === 'low-confidence model; treat fold and contacts with caution',
  )
}

// --- 4. failed job surfaces the API error message
{
  const tctx = makeTctx([], (path) => {
    if (path.includes('pred_4'))
      return jsonRes({ status: 'failed', error: { message: 'MSA generation exploded' } })
    return jsonRes({ id: 'pred_4', status: 'pending' })
  })
  const res = await spec.execute({ sequences: 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK' }, tctx)
  ok(
    'failed job → isError with message',
    res.isError === true &&
      String(res.content[0].text?.message ?? res.content[0].text).includes('MSA generation exploded'),
  )
}

// --- 5. single chain without ligand refuses (tool is for complexes)
{
  const tctx = makeTctx([], () => jsonRes({}, 500))
  const res = await spec.execute({ sequences: 'MKTAYIAKQRQISFVKSHFSRQ' }, tctx)
  ok(
    'single chain refused',
    res.isError === true && String(res.content[0].text).includes('predict_structure'),
  )
  // …but a 400+ residue single chain is the long-chain fallback (ESMFold 413s there).
  const long = 'MKTAYIAKQRQISFVKSHFSRQ'.repeat(20) // 440 residues
  const tctxLong = makeTctx([], (path) => {
    if (path === '/compute/v1/predictions/structure-and-binding')
      return jsonRes({ id: 'pred_long', status: 'pending' })
    if (path.includes('pred_long')) {
      return jsonRes({
        status: 'succeeded',
        metrics: { ptm: 0.91, iptm: 0.0, protein_iptm: 0.0 },
        outputs: { structures: [{ url: 'https://files.example/long.pdb' }] },
      })
    }
    return { ok: true, status: 200, text: async () => PDB }
  })
  const resLong = await spec.execute({ sequences: long }, tctxLong)
  ok(
    '400+ residue single chain accepted (API path)',
    !resLong.isError &&
      resLong.structured?.chains === 1 &&
      resLong.structured?.iptm === undefined &&
      resLong.structured?.proteinIptm === undefined,
    JSON.stringify(resLong.structured ?? resLong.content[0].text).slice(0, 200),
  )
  ok(
    'single-chain API verdict from pTM',
    resLong.structured?.verdict === 'high-confidence single-chain fold',
    String(resLong.structured?.verdict),
  )
}

// --- 6. deadline exceeded while job still running → resumable prediction id.
// waitForPrediction polls on a real 10 s timer; fast-forward Date.now instead —
// the jump kicks in after the first poll so the deadline check trips immediately.
{
  const realNow = Date.now
  let polls = 0 // responder invocations: 1 = submit, 2 = first status poll
  const tctx = makeTctx([], () => {
    polls++
    return jsonRes({ id: 'pred_6', status: 'pending' })
  })
  Date.now = () => realNow() + (polls >= 2 ? 20 * 60_000 : 0)
  const res = await spec.execute({ sequences: 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK' }, tctx)
  Date.now = realNow
  const r = res.structured ?? {}
  ok(
    'timeout surfaces resumable prediction id',
    !res.isError && r.predictionId === 'pred_6' && r.timedOut === true,
  )
  ok('timeout note gives resume instruction', String(r.note ?? '').includes('prediction_id: "pred_6"'))
  ok('exactly one status poll before deadline hit', polls === 2 && Date.now === realNow)
}

// --- 7. resume an existing job by prediction_id (no new submission)
{
  const calls: Call[] = []
  const tctx = makeTctx(calls, (path) => {
    if (path === '/compute/v1/predictions/structure-and-binding')
      return jsonRes({ error: { message: 'must not resubmit' } }, 500)
    if (path.startsWith('/compute/v1/predictions/structure-and-binding/pred_7')) {
      return jsonRes({
        status: 'succeeded',
        metrics: { ptm: 0.9, iptm: 0.87, binding_confidence: 0.81 },
        outputs: { structures: [{ url: 'https://files.example/p7.pdb' }] },
      })
    }
    return { ok: true, status: 200, text: async () => PDB }
  })
  const res = await spec.execute(
    { sequences: 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK', prediction_id: 'pred_7', name: 'resumed' },
    tctx,
  )
  const r = res.structured ?? {}
  ok('resume polls existing job', !res.isError && r.savedTo === 'structures/resumed_boltz.pdb')
  ok('resume never resubmits', !calls.some((c) => c.init.method === 'POST'))
  ok('resume verdict from binding confidence', r.verdict === 'predicted to bind with high confidence')
}

// --- 5. local mode: no key, fake boltz CLI produces model + confidences
{
  delete process.env.BOLTZ_API_KEY
  process.env.AGH_HOME = '/tmp/unit-test-no-such-agh'
  mkdirSync('/tmp/boltz-fake-bin', { recursive: true })
  const fakeBin = '/tmp/boltz-fake-bin/boltz'
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
echo '{"ptm":0.9,"iptm":0.85,"ligand_iptm":0.8,"protein_iptm":0.7}' > "$OUT/predictions/input/confidence_model_0.json"
echo '{"affinity_probability_binary":0.91,"affinity_pred_value":-6.2}' > "$OUT/predictions/input/affinity_input.json"
`,
    { mode: 0o755 },
  )
  process.env.BOLTZ_LOCAL_BIN = fakeBin
  const tctx = makeTctx([], () => {
    throw new Error('network must not be used in local mode')
  })
  const res = await spec.execute(
    {
      sequences: 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK',
      ligand_smiles: 'CC(=O)OC1=CC=CC=C1C(=O)O',
      name: 'local pair',
    },
    tctx,
  )
  const r = res.structured ?? {}
  ok(
    'local mode runs without a key',
    !res.isError && r.engine === 'boltz2-local',
    JSON.stringify(r).slice(0, 200),
  )
  ok(
    'local mode saves workspace PDB',
    String(tctx.written.get('structures/local_pair_boltz_local.pdb') ?? '').includes('CA  ALA'),
  )
  ok(
    'local mode scales confidences to 0-100',
    r.ptm === 90 && r.iptm === 85 && r.bindingConfidence === 91,
    JSON.stringify(r.metrics ?? r).slice(0, 120),
  )
  ok('local mode verdict from affinity', r.verdict === 'predicted to bind with high confidence')
  ok('local mode residue count', r.residues === 4)
  ok('local mode flags ligand + chains', r.chains === 2 && r.hasLigand === true)
  // Ligand-free local run: boltz still reports ligand_iptm 0.0 — it must not surface.
  const res2 = await spec.execute(
    { sequences: 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK', name: 'local bare' },
    tctx,
  )
  const r2 = res2.structured ?? {}
  ok(
    'ligand-free local run hides ligandIptm',
    !res2.isError && r2.hasLigand === false && r2.ligandIptm === undefined,
    JSON.stringify(r2).slice(0, 160),
  )
  ok('two-protein local run keeps proteinIptm', r2.proteinIptm === 70, JSON.stringify(r2).slice(0, 160))
  // Single protein + ligand: protein_iptm is 0.0 in the real output — noise, drop it.
  const res3 = await spec.execute(
    { sequences: 'MKTAYIAKQRQISFVKSHFSRQ', ligand_smiles: 'CC(=O)OC1=CC=CC=C1C(=O)O', name: 'local single' },
    tctx,
  )
  const r3 = res3.structured ?? {}
  ok(
    'single-protein local run hides proteinIptm',
    !res3.isError && r3.chains === 1 && r3.hasLigand === true && r3.proteinIptm === undefined,
    JSON.stringify(r3).slice(0, 160),
  )
  ok('single-protein local run keeps ligandIptm', r3.ligandIptm === 80, JSON.stringify(r3).slice(0, 160))
  // Pure single chain (no ligand): accepted at 400+ residues locally; the
  // report collapses to pTM-level confidence.
  const res4 = await spec.execute(
    { sequences: 'MKTAYIAKQRQISFVKSHFSRQ'.repeat(20), name: 'local long single' },
    tctx,
  )
  const r4 = res4.structured ?? {}
  ok(
    '400+ single-chain local run accepted',
    !res4.isError && r4.chains === 1 && r4.hasLigand === false && r4.iptm === undefined,
    JSON.stringify(r4).slice(0, 160),
  )
  ok(
    'single-chain local verdict from pTM',
    r4.verdict === 'high-confidence single-chain fold',
    String(r4.verdict),
  )
  delete process.env.BOLTZ_LOCAL_BIN
}

console.log('BOLTZ FLOW TESTS DONE')
process.exit(process.exitCode ?? 0)
