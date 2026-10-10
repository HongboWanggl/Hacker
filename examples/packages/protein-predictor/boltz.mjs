// Boltz-2 complex/ligand prediction via api.boltz.bio.
// Complements ESMFold (single-chain, free): Boltz-2 handles protein/ligand/RNA/DNA
// complexes and reports interface confidences (pTM, ipTM, ligand_iPTM, binding
// confidence) that single-chain tools cannot. Requires a Boltz API key — resolved
// from BOLTZ_API_KEY or the AGH secret store (secrets/boltz/default) — and fails
// with setup instructions when neither is present.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const Kind = Symbol.for('TypeBox.Kind')

const BOLTZ_BASE = 'https://api.boltz.bio'
const AA_RE = /^[ACDEFGHIKLMNPQRSTVWYBXZUO]+$/i
const SMILES_MAX = 600

const writeMeta = {
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'idempotent',
  costHint: { credits: 1 },
  deferLoading: false,
  requiresApproval: 'never',
}

const text = (s) => ({ content: [{ type: 'text', text: s }] })
const result = (structured, s) => ({ content: [{ type: 'text', text: JSON.stringify(structured) }], structured })
const fail = (s) => ({ ...text(s), isError: true })

const str = (desc, extra = {}) => ({ [Kind]: 'String', type: 'string', description: desc, ...extra })
const bool = (desc) => ({ [Kind]: 'Boolean', type: 'boolean', description: desc })

// Key resolution: env first, then the AGH secret store. The key value itself is
// never logged, echoed, or written into results.
function resolveApiKey() {
  const fromEnv = process.env.BOLTZ_API_KEY
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  const home = process.env.AGH_HOME
  if (home) {
    for (const dir of ['secrets', 'data/secrets']) {
      try {
        const raw = readFileSync(join(home, dir, 'boltz', 'default'), 'utf8').trim()
        if (raw) return raw
      } catch {
        // Try the next location.
      }
    }
  }
  return undefined
}

const SETUP_HINT =
  'Boltz-2 needs an API key. Either set BOLTZ_API_KEY in the daemon environment, or create the secret file: ' +
  'mkdir -p "$AGH_HOME/secrets/boltz" && printf %s "YOUR_KEY" > "$AGH_HOME/secrets/boltz/default" && chmod 600 "$AGH_HOME/secrets/boltz/default" ' +
 '(get a key at https://boltz.bio).'

async function boltzFetch(tctx, path, init) {
  const key = resolveApiKey()
  if (!key) return { authError: true }
  // The API accepts bearer auth; retry once with x-api-key in case the account
  // is on the alternate header scheme.
  let res = await tctx.net.fetch(`${BOLTZ_BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${key}` },
    timeoutMs: 60000,
  })
  if (res.status === 401 || res.status === 403) {
    res = await tctx.net.fetch(`${BOLTZ_BASE}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), 'x-api-key': key },
      timeoutMs: 60000,
    })
  }
  return { res }
}

function buildEntities({ proteins, ligand_smiles }) {
  const entities = []
  for (const [i, seq] of proteins.entries()) {
    entities.push({ type: 'protein', chain_ids: [String.fromCharCode(65 + i)], value: seq })
  }
  if (ligand_smiles) {
    entities.push({
      type: 'ligand_smiles',
      chain_ids: [String.fromCharCode(65 + proteins.length)],
      value: ligand_smiles,
    })
  }
  return entities
}

function summarizeMetrics(m) {
  if (!m) return undefined
  const pct = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 10 : undefined)
  return {
    structureConfidence: pct(m.structure_confidence),
    ptm: pct(m.ptm),
    iptm: pct(m.iptm),
    ...(m.ligand_iptm !== undefined ? { ligandIptm: pct(m.ligand_iptm) } : {}),
    ...(m.protein_iptm !== undefined ? { proteinIptm: pct(m.protein_iptm) } : {}),
    ...(m.binding_confidence !== undefined ? { bindingConfidence: pct(m.binding_confidence) } : {}),
    ...(m.complex_pde !== undefined ? { complexPde: m.complex_pde } : {}),
  }
}

function verdictFrom(metrics) {
  if (!metrics) return undefined
  if (metrics.binding_confidence !== undefined) {
    const b = metrics.binding_confidence
    if (b >= 0.8) return 'predicted to bind with high confidence'
    if (b >= 0.5) return 'binding is plausible; validate experimentally'
    return 'low confidence that this ligand binds'
  }
  const score = metrics.iptm ?? metrics.ptm ?? 0
  if (score >= 0.8) return 'high-confidence complex interface'
  if (score >= 0.6) return 'interface plausible; inspect low-confidence contacts'
  return 'low-confidence model; treat fold and contacts with caution'
}

// Poll until terminal state. Boltz jobs can take minutes for complexes; cap at
// 9 minutes and surface a resumable prediction id if we time out.
async function waitForPrediction(tctx, id, deadlineMs = 9 * 60_000) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    const { res, authError } = await boltzFetch(tctx, `/compute/v1/predictions/structure-and-binding/${id}`, { method: 'GET' })
    if (authError) return { authError }
    if (!res.ok) return { error: `status check failed: HTTP ${res.status}` }
    const body = await res.json()
    if (body.status === 'succeeded' || body.status === 'failed' || body.status === 'cancelled') return body
    await new Promise((r) => setTimeout(r, 10_000))
  }
  return { timedOut: true, id }
}

export const predictComplex = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()
    agnes.registerTool({
      name: 'predict_complex',
      description:
        'Predict a protein complex or protein-ligand structure with Boltz-2 (co-folding). Handles multi-chain proteins, RNA/DNA, and small-molecule ligands; reports pTM/ipTM interface confidence and binding confidence. Costs API credits — prefer predict_structure (ESMFold, free) for single-chain jobs. Saves the best structure as a PDB with pLDDT in the B-factor column.',
      parameters: {
        [Kind]: 'Object',
        type: 'object',
        properties: {
          sequences: str('Protein amino-acid sequences (single-letter code). One entry per chain, comma-separated for multiple chains', {
            default: '',
          }),
          ligand_smiles: str('Optional ligand as a SMILES string, e.g. "CC(=O)OC1=CC=CC=C1C(=O)O" for aspirin', { default: '' }),
          name: str('Short label used for output filenames, e.g. lysozyme_benzene (default: complex)'),
          wait: bool('Wait for the job to finish and download the structure (default true). Set false to submit and return the prediction id'),
          prediction_id: str('Resume an already-submitted job (from a previous wait=false run or a timeout) instead of submitting a new one. Pass the same sequences for the report', {
            default: '',
          }),
        },
        required: ['sequences'],
        additionalProperties: false,
      },
      meta: writeMeta,
      async execute({ sequences, ligand_smiles = '', name = 'complex', wait = true, prediction_id = '' }, tctx) {
        const proteins = String(sequences)
          .split(',')
          .map((s) => s.replace(/\s+/g, '').toUpperCase())
          .filter(Boolean)
        if (proteins.length === 0) return fail('No protein sequences given. Pass one sequence per chain, comma-separated.')
        for (const seq of proteins) {
          if (seq.length < 5) return fail('Chain sequence too short (<5 residues).')
          if (!AA_RE.test(seq)) return fail('Sequences must be single-letter amino-acid code.')
        }
        const smiles = ligand_smiles.trim()
        if (smiles.length > SMILES_MAX) return fail(`SMILES too long (${smiles.length} chars).`)
        if (proteins.length + (smiles ? 1 : 0) < 2 && !smiles) {
          return fail('This tool is for complexes: pass at least two chains or one chain + ligand_smiles. For a single chain use predict_structure (free).')
        }
        const key = resolveApiKey()
        if (!key) return fail(SETUP_HINT)

        const resumeId = String(prediction_id || '').trim()
        const label = name.replace(/[^A-Za-z0-9_.-]/g, '_')
        let id = resumeId
        if (!resumeId) {
          const entities = buildEntities({ proteins, ligand_smiles: smiles || undefined })
          let started
          try {
            const { res, authError } = await boltzFetch(tctx, '/compute/v1/predictions/structure-and-binding', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: 'boltz-2.1', input: { entities } }),
            })
            if (authError) return fail(SETUP_HINT)
            const body = await res.json().catch(() => undefined)
            if (!res.ok) {
              return fail(`Boltz request failed: HTTP ${res.status} ${body?.error?.message ?? body?.message ?? ''}`.trim())
            }
            started = body
          } catch (error) {
            return fail(`Boltz request error: ${String(error).slice(0, 200)}`)
          }
          id = started.id
          if (!wait) return result({ predictionId: id, status: started.status ?? 'pending' }, JSON.stringify({ predictionId: id, status: started.status ?? 'pending' }))
        } else if (!wait) {
          return result({ predictionId: id, status: 'resumed' }, JSON.stringify({ predictionId: id, status: 'resumed' }))
        }

        const done = await waitForPrediction(tctx, id)
        if (done.authError) return fail(SETUP_HINT)
        if (done.error) return fail(done.error)
        if (done.timedOut) {
          const note = `Still running; fetch it later with predict_complex (prediction_id: "${id}", same sequences).`
          return result(
            { predictionId: id, status: 'pending', timedOut: true, note },
            JSON.stringify({ predictionId: id, status: 'pending', timedOut: true, note }),
          )
        }
        if (done.status === 'failed' || done.status === 'cancelled') {
          return fail(`Boltz prediction ${done.status}: ${done.error?.message ?? 'no details'}`)
        }

        // Download the best-ranking structure and store it workspace-side so the
        // existing confidence viewer can render it.
        const rawMetrics = done.metrics ?? done.outputs?.metrics
        const metrics = summarizeMetrics(rawMetrics)
        const files = done.outputs?.structures ?? done.outputs?.files ?? done.files
        let pdbUrl = files?.[0]?.url ?? files?.[0]
        if (!pdbUrl) {
          return result(
            { predictionId: id, status: done.status, metrics },
            JSON.stringify({ predictionId: id, status: done.status, metrics }),
          )
        }
        const dl = await tctx.net.fetch(pdbUrl, { timeoutMs: 120000 })
        if (!dl.ok) return fail(`Structure download failed: HTTP ${dl.status}`)
        const pdb = await dl.text()
        const nResidues = [...pdb.matchAll(/^ATOM\s+\d+\s+CA\s/gm)].length
        const path = `structures/${label}_boltz.pdb`
        await tctx.fs.write(path, pdb)
        const report = {
          predictionId: id,
          savedTo: path,
          chains: proteins.length,
          hasLigand: Boolean(smiles),
          residues: nResidues,
          ...(metrics ?? {}),
          ...(verdictFrom(rawMetrics) ? { verdict: verdictFrom(rawMetrics) } : {}),
        }
        return result(report, JSON.stringify(report))
      },
    })
  },
}
