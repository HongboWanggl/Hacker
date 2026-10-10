// predict_complex full job lifecycle against a mocked Boltz API — the only
// executable coverage of the submit → poll → download → metrics path (the real
// API needs a paid key). Covers: wait=false submit, bearer→x-api-key fallback,
// success parsing (metrics scaled to 0-100, verdict), failed-job surfacing,
// and the "complexes only" guard.
import { predictComplex } from '/Users/wanghanbao/agnes-harness/examples/packages/protein-predictor/boltz.mjs'

const captured: any[] = []
predictComplex.apply({ extension: () => ({ registerTool: (t: any) => captured.push(t) }) })
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

function makeTctx(calls: { path: string; init: any }[], responder: (path: string, init: any) => any) {
  const written = new Map<string, string>()
  return {
    calls,
    written,
    net: {
      fetch: async (url: string, init: any = {}) => {
        const path = url.replace('https://api.boltz.bio', '').replace(/^https?:\/\/[^/]+/, '')
        calls.push({ path, init })
        return responder(path, init)
      },
    },
    fs: { write: async (p: string, data: any) => written.set(p, String(data)) },
  }
}
const jsonRes = (obj: any, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) })

// --- 1. wait=false: submit only, no polling
{
  const calls: any[] = []
  const tctx = makeTctx(calls, () => jsonRes({ id: 'pred_1', status: 'pending' }))
  const res = await spec.execute({ sequences: 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK', wait: false }, tctx)
  ok('submit-only returns prediction id', res.structured?.predictionId === 'pred_1')
  ok('submit-only makes exactly 1 call', calls.length === 1)
  ok('bearer auth on submit', String(calls[0]?.init?.headers?.Authorization ?? '').startsWith('Bearer unit-test-fake-key'))
  ok('request is boltz-2.1 with two protein entities', JSON.parse(calls[0].init.body).model === 'boltz-2.1' && JSON.parse(calls[0].init.body).input.entities.length === 2)
}

// --- 2. full success: poll (already-terminal) → download → parse
{
  const calls: any[] = []
  const tctx = makeTctx(calls, (path) => {
    if (path === '/compute/v1/predictions/structure-and-binding') return jsonRes({ id: 'pred_2', status: 'pending' })
    if (path.startsWith('/compute/v1/predictions/structure-and-binding/pred_2')) {
      return jsonRes({
        status: 'succeeded',
        metrics: { structure_confidence: 0.842, ptm: 0.881, iptm: 0.825, ligand_iptm: 0.799, binding_confidence: 0.873 },
        outputs: { structures: [{ url: 'https://files.example/pred_2_best.pdb' }] },
      })
    }
    if (path.includes('pred_2_best.pdb')) return { ok: true, status: 200, text: async () => PDB }
    return jsonRes({ error: { message: 'unexpected ' + path } }, 404)
  })
  const res = await spec.execute(
    { sequences: 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK', ligand_smiles: 'CC(=O)OC1=CC=CC=C1C(=O)O', name: 'mock pair' },
    tctx,
  )
  const r = res.structured ?? {}
  ok('success not error', !res.isError)
  ok('pdb saved to workspace', r.savedTo === 'structures/mock_pair_boltz.pdb' && (tctx.written.get('structures/mock_pair_boltz.pdb') ?? '').startsWith('ATOM'))
  ok('chains + ligand reported', r.chains === 2 && r.hasLigand === true)
  ok('residue count from CA lines', r.residues === 4)
  ok('metrics scaled to 0-100', r.structureConfidence === 84.2 && r.bindingConfidence === 87.3 && r.iptm === 82.5 && r.ligandIptm === 79.9)
  ok('high-confidence verdict', r.verdict === 'predicted to bind with high confidence')
  ok('ligand gets next chain id', JSON.parse(calls[0].init.body).input.entities[2]?.chain_ids?.[0] === 'C')
}

// --- 3. bearer 401 → x-api-key fallback still succeeds
{
  const calls: any[] = []
  const tctx = makeTctx(calls, (path, init) => {
    if (path === '/compute/v1/predictions/structure-and-binding') return jsonRes({ id: 'pred_3', status: 'pending' })
    if (init.headers?.Authorization) return jsonRes({ error: { message: 'unauthorized' } }, 401)
    if (path.startsWith('/compute/v1/predictions/structure-and-binding/pred_3')) {
      return jsonRes({ status: 'succeeded', metrics: { ptm: 0.7, iptm: 0.55 }, outputs: { structures: [{ url: 'https://files.example/p3.pdb' }] } })
    }
    return { ok: true, status: 200, text: async () => PDB }
  })
  const res = await spec.execute({ sequences: 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK' }, tctx)
  ok('x-api-key fallback used', !res.isError && calls.some((c) => c.init.headers?.['x-api-key']))
  ok('iptm-only verdict path', res.structured?.verdict === 'low-confidence model; treat fold and contacts with caution')
}

// --- 4. failed job surfaces the API error message
{
  const tctx = makeTctx([], (path) => {
    if (path.includes('pred_4')) return jsonRes({ status: 'failed', error: { message: 'MSA generation exploded' } })
    return jsonRes({ id: 'pred_4', status: 'pending' })
  })
  const res = await spec.execute({ sequences: 'MKTAYIAKQRQISFVKSHFSRQ,EIAKQGQVTMVIKKSMLEK' }, tctx)
  ok('failed job → isError with message', res.isError === true && String(res.content[0].text?.message ?? res.content[0].text).includes('MSA generation exploded'))
}

// --- 5. single chain without ligand refuses (tool is for complexes)
{
  const tctx = makeTctx([], () => jsonRes({}, 500))
  const res = await spec.execute({ sequences: 'MKTAYIAKQRQISFVKSHFSRQ' }, tctx)
  ok('single chain refused', res.isError === true && String(res.content[0].text).includes('predict_structure'))
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
  ok('timeout surfaces resumable prediction id', !res.isError && r.predictionId === 'pred_6' && r.timedOut === true)
  ok('timeout note gives resume instruction', String(r.note ?? '').includes('prediction_id: "pred_6"'))
  ok('exactly one status poll before deadline hit', polls === 2 && Date.now === realNow)
}

// --- 7. resume an existing job by prediction_id (no new submission)
{
  const calls: any[] = []
  const tctx = makeTctx(calls, (path) => {
    if (path === '/compute/v1/predictions/structure-and-binding') return jsonRes({ error: { message: 'must not resubmit' } }, 500)
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

console.log('BOLTZ FLOW TESTS DONE')
process.exit(process.exitCode ?? 0)
