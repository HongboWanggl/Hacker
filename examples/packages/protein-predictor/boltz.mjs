// Boltz-2 complex/ligand prediction via api.boltz.bio, with a local fallback.
// Complements ESMFold (single-chain, free): Boltz-2 handles protein/ligand/RNA/DNA
// complexes and reports interface confidences (pTM, ipTM, ligand_iPTM, binding
// confidence) that single-chain tools cannot. With a key (BOLTZ_API_KEY or the
// AGH secret store) it calls the API; without one it runs the open-source
// weights locally when the boltz-community CLI is installed (Apple MPS or
// CUDA), and only fails with setup instructions when neither path exists.

import { execFile } from 'node:child_process'
import { accessSync, constants as fsConstants, readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

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
const result = (structured, _s) => ({
  content: [{ type: 'text', text: JSON.stringify(structured) }],
  structured,
})
const fail = (s) => ({ ...text(s), isError: true })

const str = (desc, extra = {}) => ({ [Kind]: 'String', type: 'string', description: desc, ...extra })
const bool = (desc) => ({ [Kind]: 'Boolean', type: 'boolean', description: desc })

// Key resolution: env first, then the AGH secret store. The key value itself is
// never logged, echoed, or written into results.
function resolveApiKey() {
  const fromEnv = process.env.BOLTZ_API_KEY
  if (fromEnv?.trim()) return fromEnv.trim()
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
  '(get a key at https://boltz.bio). Alternatively install the open-source weights locally: ' +
  'uv venv --python 3.12 ~/boltz2/venv && uv pip install --python ~/boltz2/venv/bin/python boltz-community ' +
  '(Apple Silicon uses MPS; first run downloads ~10 GB of weights).'

// Local open-source fallback: the boltz-community fork (Apple MPS / CUDA).
// Detect the CLI; BOLTZ_LOCAL_BIN overrides the default venv path.
function resolveLocalBoltz() {
  const candidates = [
    process.env.BOLTZ_LOCAL_BIN,
    join(process.env.HOME ?? '', 'boltz2', 'venv', 'bin', 'boltz'),
  ].filter(Boolean)
  for (const p of candidates) {
    try {
      accessSync(p, fsConstants.X_OK)
      return p
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

// Run a prediction locally and shape the result like the API path so the panel
// renders identically. Local runs take minutes (MPS fp32, roughly 1-2x slower
// than a T4); the first ever run also downloads ~10 GB of weights.
async function runLocalBoltz({ proteins, smiles }) {
  const bin = resolveLocalBoltz()
  if (!bin) return { missing: true }
  const exec = promisify(execFile)
  const work = await mkdtemp(join(tmpdir(), 'boltz-local-'))
  await mkdir(join(work, 'out'), { recursive: true })
  const yaml = ['sequences:']
  for (const [i, seq] of proteins.entries()) {
    yaml.push(`  - protein:\n      id: ${String.fromCharCode(65 + i)}\n      sequence: ${seq}`)
  }
  if (smiles) {
    // The affinity pass only runs when the ligand is declared as the binder via
    // a top-level properties block; `affinity: true` on the ligand is ignored.
    const ligandId = String.fromCharCode(65 + proteins.length)
    yaml.push(`  - ligand:\n      id: ${ligandId}\n      smiles: ${smiles}`)
    yaml.push(`properties:\n  - affinity:\n      binder: ${ligandId}`)
  }
  await writeFile(join(work, 'input.yaml'), `${yaml.join('\n')}\n`, 'utf8')
  // Local mode is synchronous — no job id exists, so `wait` is advisory only.
  let stdout = ''
  try {
    ;({ stdout } = await exec(
      bin,
      [
        'predict',
        join(work, 'input.yaml'),
        '--accelerator',
        'mps',
        '--use_msa_server',
        '--output_format',
        'pdb',
        '--out_dir',
        join(work, 'out'),
      ],
      {
        timeout: 20 * 60_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    ))
  } catch (error) {
    const msg = String(error?.message ?? error)
    if (killed(error))
      return {
        error: `Local Boltz-2 timed out after 20 min (${msg.slice(0, 120)}). Try smaller targets or the API.`,
      }
    // The tail of the message carries the actual exception; the head is the exec line + progress bars.
    return { error: `Local Boltz-2 failed: ${msg.slice(-400)}` }
  }
  // Locate the best model: the deepest model_0.pdb under the out dir plus the
  // confidence/affinity JSONs next to it (boltz names them
  // `{input}_model_0.pdb` / `confidence_{input}_model_0.json`). The PAE matrix
  // (`pae_{input}_model_0.npz`) rides along for the panel's error heatmap.
  const outRoot = join(work, 'out')
  const stack = [outRoot]
  let modelPdb = null
  let paeNpz = null
  while (stack.length && (!modelPdb || !paeNpz)) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name.endsWith('model_0.pdb')) modelPdb = p
      else if (e.name.startsWith('pae_') && e.name.endsWith('model_0.npz')) paeNpz = p
    }
  }
  if (!modelPdb) return { error: `Local Boltz-2 finished but no model_0.pdb found under ${outRoot}` }
  const beside = (prefix, suffix = '_model_0.json') => {
    try {
      const dir = modelPdb.slice(0, modelPdb.lastIndexOf('/'))
      const hit = readdirSync(dir).find((f) => f.startsWith(`${prefix}_`) && f.endsWith(suffix))
      return hit ? JSON.parse(readFileSync(join(dir, hit), 'utf8')) : undefined
    } catch {
      return undefined
    }
  }
  const conf = beside('confidence') ?? {}
  // boltz names this `affinity_{input}.json` — no model suffix.
  const aff = beside('affinity', '.json') ?? {}
  return { modelPdb, paeNpz, conf, aff, stdout: stdout.slice(-400) }
}

function killed(error) {
  return (
    error?.killed === true ||
    String(error?.message ?? '').includes('TIMEDOUT') === true ||
    String(error?.message ?? '').includes('ETIMEDOUT') === true
  )
}

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

// Single-chain fallback runs have no interface to score: judge by pTM alone.
function foldVerdict(ptm) {
  if (ptm >= 0.8) return 'high-confidence single-chain fold'
  if (ptm >= 0.6) return 'fold plausible; inspect low-confidence regions'
  return 'low-confidence fold; treat with caution'
}

// Poll until terminal state. Boltz jobs can take minutes for complexes; cap at
// 9 minutes and surface a resumable prediction id if we time out.
async function waitForPrediction(tctx, id, deadlineMs = 9 * 60_000) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    const { res, authError } = await boltzFetch(tctx, `/compute/v1/predictions/structure-and-binding/${id}`, {
      method: 'GET',
    })
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
        'Predict a protein complex or protein-ligand structure with Boltz-2 (co-folding). Handles multi-chain proteins, RNA/DNA, and small-molecule ligands; reports pTM/ipTM interface confidence and binding confidence. Uses the Boltz API when a key is configured (costs credits); otherwise runs the open-source weights locally via the boltz-community CLI (slow: minutes per target, first run downloads ~10 GB) — prefer predict_structure (ESMFold, free) for single-chain jobs under 400 residues; single chains of 400+ residues are accepted here as the long-chain fallback (ESMFold rejects those). Saves the best structure as a PDB with pLDDT in the B-factor column.',
      parameters: {
        [Kind]: 'Object',
        type: 'object',
        properties: {
          sequences: str(
            'Protein amino-acid sequences (single-letter code). One entry per chain, comma-separated for multiple chains',
            {
              default: '',
            },
          ),
          ligand_smiles: str(
            'Optional ligand as a SMILES string, e.g. "CC(=O)OC1=CC=CC=C1C(=O)O" for aspirin',
            { default: '' },
          ),
          name: str('Short label used for output filenames, e.g. lysozyme_benzene (default: complex)'),
          wait: bool(
            'Wait for the job to finish and download the structure (default true). Set false to submit and return the prediction id',
          ),
          prediction_id: str(
            'Resume an already-submitted job (from a previous wait=false run or a timeout) instead of submitting a new one. Pass the same sequences for the report',
            {
              default: '',
            },
          ),
        },
        required: ['sequences'],
        additionalProperties: false,
      },
      meta: writeMeta,
      async execute(
        { sequences, ligand_smiles = '', name = 'complex', wait = true, prediction_id = '' },
        tctx,
      ) {
        const proteins = String(sequences)
          .split(',')
          .map((s) => s.replace(/\s+/g, '').toUpperCase())
          .filter(Boolean)
        if (proteins.length === 0)
          return fail('No protein sequences given. Pass one sequence per chain, comma-separated.')
        for (const seq of proteins) {
          if (seq.length < 5) return fail('Chain sequence too short (<5 residues).')
          if (!AA_RE.test(seq)) return fail('Sequences must be single-letter amino-acid code.')
        }
        const smiles = ligand_smiles.trim()
        if (smiles.length > SMILES_MAX) return fail(`SMILES too long (${smiles.length} chars).`)
        // Single chain + no ligand is accepted only as the long-chain fallback:
        // the free ESMFold endpoint 413s past ~400 residues, and Boltz-2 folds
        // those single chains fine (locally or via the API).
        const singleChain = proteins.length === 1 && !smiles
        if (proteins.length + (smiles ? 1 : 0) < 2) {
          if (!(singleChain && proteins[0].length >= 400)) {
            return fail(
              'This tool is for complexes: pass at least two chains or one chain + ligand_smiles. ' +
                'For a single chain under 400 residues use predict_structure (free, fast); ' +
                'single chains of 400+ residues are accepted here as the long-chain fallback.',
            )
          }
        }
        const key = resolveApiKey()
        const label = name.replace(/[^A-Za-z0-9_.-]/g, '_')
        // No key → run the open-source weights locally when the CLI exists.
        if (!key) {
          if (!resolveLocalBoltz()) return fail(SETUP_HINT)
          const t0 = Date.now()
          const out = await runLocalBoltz({ proteins, smiles, label, wait })
          if (out.missing) return fail(SETUP_HINT)
          if (out.error) return fail(out.error)
          // boltz writes pLDDT into the PDB B-factor column, so the existing
          // confidence viewer renders local models without extra work.
          const pdb = await readFile(out.modelPdb, 'utf8')
          const nResidues = [...pdb.matchAll(/^ATOM\s+\d+\s+CA\s/gm)].length
          const path = `structures/${label}_boltz_local.pdb`
          await tctx.fs.write(path, pdb)
          const pct = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 10 : undefined)
          const metrics = {
            ...(pct(out.conf?.ptm) !== undefined ? { ptm: pct(out.conf.ptm) } : {}),
            ...(pct(out.conf?.iptm) !== undefined && !singleChain ? { iptm: pct(out.conf.iptm) } : {}),
            // A ligand-free run still reports ligand_iptm: 0.0 — surfacing it
            // would render a meaningless "ligand ipTM 0" chip. Same for
            // protein_iptm on single-protein runs (no protein interface exists).
            ...(smiles && pct(out.conf?.ligand_iptm) !== undefined
              ? { ligandIptm: pct(out.conf.ligand_iptm) }
              : {}),
            ...(proteins.length >= 2 && pct(out.conf?.protein_iptm) !== undefined
              ? { proteinIptm: pct(out.conf.protein_iptm) }
              : {}),
            ...(pct(out.aff?.affinity_probability_binary ?? out.aff?.affinity_probability) !== undefined
              ? {
                  bindingConfidence: pct(out.aff.affinity_probability_binary ?? out.aff.affinity_probability),
                }
              : {}),
          }
          const affProb = out.aff?.affinity_probability_binary ?? out.aff?.affinity_probability
          // A single chain has no interface and no binder: judge the fold itself
          // by pTM instead of the ipTM-family scores (which come back as 0.0).
          const verdict = singleChain
            ? foldVerdict(out.conf?.ptm ?? 0)
            : affProb != null
              ? verdictFrom({ binding_confidence: affProb })
              : verdictFrom({ iptm: out.conf?.iptm ?? out.conf?.ptm ?? 0 })
          const report = {
            engine: 'boltz2-local',
            savedTo: path,
            chains: proteins.length,
            hasLigand: Boolean(smiles),
            residues: nResidues,
            ...metrics,
            ...(verdict ? { verdict } : {}),
            runtimeSec: Math.round((Date.now() - t0) / 1000),
          }
          // Persist the PAE matrix for the panel's error heatmap. Best-effort:
          // its absence only hides the heatmap, never the model itself.
          if (out.paeNpz) {
            try {
              const paePath = `structures/${label}_pae.npz`
              await tctx.fs.write(paePath, await readFile(out.paeNpz))
              report.paePath = paePath
            } catch {
              // npz copy failure is cosmetic; keep the report.
            }
          }
          return result(report, JSON.stringify(report))
        }

        const resumeId = String(prediction_id || '').trim()
        let id = resumeId
        if (!resumeId) {
          const entities = buildEntities({ proteins, ligand_smiles: smiles || undefined })
          let started
          try {
            const { res, authError } = await boltzFetch(
              tctx,
              '/compute/v1/predictions/structure-and-binding',
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'boltz-2.1', input: { entities } }),
              },
            )
            if (authError) return fail(SETUP_HINT)
            const body = await res.json().catch(() => undefined)
            if (!res.ok) {
              return fail(
                `Boltz request failed: HTTP ${res.status} ${body?.error?.message ?? body?.message ?? ''}`.trim(),
              )
            }
            started = body
          } catch (error) {
            return fail(`Boltz request error: ${String(error).slice(0, 200)}`)
          }
          id = started.id
          if (!wait)
            return result(
              { predictionId: id, status: started.status ?? 'pending' },
              JSON.stringify({ predictionId: id, status: started.status ?? 'pending' }),
            )
        } else if (!wait) {
          return result(
            { predictionId: id, status: 'resumed' },
            JSON.stringify({ predictionId: id, status: 'resumed' }),
          )
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
        const metricsAll = summarizeMetrics(rawMetrics)
        // Single-chain fallback: ipTM-family scores come back as 0.0 — collapse
        // the report to structure-level confidence, judged by pTM.
        const metrics =
          singleChain && metricsAll
            ? {
                ptm: metricsAll.ptm,
                structureConfidence: metricsAll.structureConfidence,
                complexPde: metricsAll.complexPde,
              }
            : metricsAll
        const files = done.outputs?.structures ?? done.outputs?.files ?? done.files
        const pdbUrl = files?.[0]?.url ?? files?.[0]
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
          ...(singleChain
            ? { verdict: foldVerdict(rawMetrics?.ptm ?? 0) }
            : verdictFrom(rawMetrics)
              ? { verdict: verdictFrom(rawMetrics) }
              : {}),
        }
        return result(report, JSON.stringify(report))
      },
    })
  },
}
