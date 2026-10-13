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
// Exported for worker.mjs (the GPU-borrow HTTP worker deployed on GPU machines).
export async function runLocalBoltz({ proteins, smiles }) {
  const bin = resolveLocalBoltz()
  if (!bin) return { missing: true }
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
  // The CLI runs as a detached process-group leader: node's execFile timeout
  // only signals the direct child, and boltz (PyTorch/MPS compute) survives
  // SIGTERM — an orphan kept hogging the GPU 30+ minutes past a timed-out run
  // (observed 2026-10-12). A group-wide SIGKILL shortly after the cap reclaims
  // the whole tree.
  let stdout = ''
  try {
    stdout = await new Promise((resolve, reject) => {
      const child = execFile(
        bin,
        [
          'predict',
          join(work, 'input.yaml'),
          '--accelerator',
          // macOS → Metal MPS; Linux servers → CUDA via the generic "gpu".
          process.platform === 'darwin' ? 'mps' : 'gpu',
          '--use_msa_server',
          '--output_format',
          'pdb',
          '--out_dir',
          join(work, 'out'),
        ],
        {
          timeout: 20 * 60_000,
          maxBuffer: 64 * 1024 * 1024,
          detached: true,
        },
        (error, out) => (error ? reject(error) : resolve(out)),
      )
      const reap = setTimeout(
        () => {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            // Already gone — node's own timeout won the race.
          }
        },
        20 * 60_000 + 5_000,
      )
      child.once('close', () => clearTimeout(reap))
    })
  } catch (error) {
    const msg = String(error?.message ?? error)
    if (killed(error))
      return {
        error: `Local Boltz-2 timed out after 20 min (${msg.slice(0, 120)}). This target exceeds what the local weights finish on this machine within the cap — DO NOT retry with the same input, it will time out again. Either split the target into domain-sized pieces (≤ ~600 aa each) and predict those, or configure a Boltz API key (BOLTZ_API_KEY / secret store) for the hosted engine.`,
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

// Persist the PAE npz for the panel's error heatmap; returns the saved
// workspace path or undefined. The fs seam checkpoints any file it OVERWRITES
// and refuses binary content there (NUL bytes → E_CHECKPOINT_UNRESTORABLE), so
// a stale npz from an earlier run blocks the canonical name. A fresh path has
// no previous bytes to capture, so retry once time-suffixed. The tool fs
// exposes no delete, so the stale file stays — cosmetic only.
async function writePaeBestEffort(tctx, label, bytes) {
  try {
    const paePath = `structures/${label}_pae.npz`
    await tctx.fs.write(paePath, bytes)
    return paePath
  } catch (error) {
    console.error(
      '[predict_complex] npz overwrite blocked, retrying unique name:',
      String(error?.message ?? error).slice(0, 160),
    )
    try {
      const paePath = `structures/${label}_${Date.now()}_pae.npz`
      await tctx.fs.write(paePath, bytes)
      return paePath
    } catch (retryError) {
      // Still cosmetic — the caller keeps its report, the log keeps the cause.
      console.error(
        '[predict_complex] pae npz copy failed:',
        String(retryError?.message ?? retryError).slice(0, 200),
      )
      return undefined
    }
  }
}

// 算力路由第一档：remote GPU worker (worker.mjs on a GPU machine, reverse-SSH
// tunneled to loopback). Health-probe first (short timeout so a dead tunnel
// costs nothing), then POST the job. ANY failure returns undefined and the
// caller falls through to the legacy chain (hosted API → local CLI → hint) —
// the worker is an accelerator, never a dependency.
const WORKER_URL = process.env.BOLTZ_WORKER_URL ?? 'http://127.0.0.1:7610'
export async function runWorkerBoltz({ proteins, smiles }) {
  try {
    const health = await fetch(`${WORKER_URL}/health`, { signal: AbortSignal.timeout(1500) })
    if (!health.ok) return undefined
    const h = await health.json()
    if (!h.ok || !h.bin) return undefined
    const headers = { 'content-type': 'application/json' }
    const token =
      process.env.BOLTZ_WORKER_TOKEN ??
      (await readFile(join(process.env.HOME ?? '', '.config', 'boltz-worker', 'token'), 'utf8')
        .then((s) => s.trim())
        .catch(() => undefined))
    if (token) headers.authorization = `Bearer ${token}`
    // 22 min > the worker's own 20 min per-job cap, so the worker always gets
    // to answer (even with a compute error) before the client gives up.
    const res = await fetch(`${WORKER_URL}/predict`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ proteins, smiles }),
      signal: AbortSignal.timeout(22 * 60_000),
    })
    if (!res.ok) return undefined // 5xx compute error → legacy chain takes it
    const out = await res.json()
    if (!out.pdb) return undefined
    return { pdbContent: out.pdb, paeNpzB64: out.paeNpzB64, conf: out.conf ?? {}, aff: out.aff ?? {} }
  } catch {
    return undefined
  }
}

// Shared tail of the worker/local paths: persist the PDB (pLDDT is in the
// B-factor column, so the existing confidence viewer renders it as-is), shape
// conf/aff into the panel's report, best-effort the PAE heatmap.
async function finishBoltzResult({
  tctx,
  proteins,
  smiles,
  singleChain,
  label,
  t0,
  pdbContent,
  paeBytes,
  conf,
  aff,
  engine,
  paeMissingNote,
}) {
  const nResidues = [...pdbContent.matchAll(/^ATOM\s+\d+\s+CA\s/gm)].length
  const path = `structures/${label}_boltz_local.pdb`
  await tctx.fs.write(path, pdbContent)
  const pct = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 10 : undefined)
  const metrics = {
    ...(pct(conf?.ptm) !== undefined ? { ptm: pct(conf.ptm) } : {}),
    ...(pct(conf?.iptm) !== undefined && !singleChain ? { iptm: pct(conf.iptm) } : {}),
    // A ligand-free run still reports ligand_iptm: 0.0 — surfacing it
    // would render a meaningless "ligand ipTM 0" chip. Same for
    // protein_iptm on single-protein runs (no protein interface exists).
    ...(smiles && pct(conf?.ligand_iptm) !== undefined ? { ligandIptm: pct(conf.ligand_iptm) } : {}),
    ...(proteins.length >= 2 && pct(conf?.protein_iptm) !== undefined
      ? { proteinIptm: pct(conf.protein_iptm) }
      : {}),
    ...(pct(aff?.affinity_probability_binary ?? aff?.affinity_probability) !== undefined
      ? {
          bindingConfidence: pct(aff.affinity_probability_binary ?? aff.affinity_probability),
        }
      : {}),
  }
  const affProb = aff?.affinity_probability_binary ?? aff?.affinity_probability
  // A single chain has no interface and no binder: judge the fold itself
  // by pTM instead of the ipTM-family scores (which come back as 0.0).
  const verdict = singleChain
    ? foldVerdict(conf?.ptm ?? 0)
    : affProb != null
      ? verdictFrom({ binding_confidence: affProb })
      : verdictFrom({ iptm: conf?.iptm ?? conf?.ptm ?? 0 })
  const report = {
    engine,
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
  if (paeBytes) {
    const paePath = await writePaeBestEffort(tctx, label, paeBytes)
    if (paePath) report.paePath = paePath
  } else if (paeMissingNote) {
    console.error(`[predict_complex] ${paeMissingNote}`)
  }
  return result(report, JSON.stringify(report))
}

// API-mode PAE pickup: the panel's heatmap rides on `paePath`, and the API may
// expose the matrix alongside the structure files. Detection is defensive —
// an entry whose name/url looks like a PAE npz is downloaded (capped, binary)
// and persisted through the same best-effort writer as local runs; anything
// else leaves the heatmap hidden rather than guessing.
const isPaeEntry = (f) => {
  const u = typeof f === 'string' ? f : (f?.url ?? f?.name ?? '')
  return /pae/i.test(String(u)) && /\.npz(\?|#|$)/i.test(String(u))
}
async function fetchApiPae(tctx, files) {
  const entry = (files ?? []).find(isPaeEntry)
  if (!entry) return undefined
  const url = typeof entry === 'string' ? entry : entry.url
  const dl = await tctx.net.fetch(url, { timeoutMs: 60000 })
  if (!dl.ok) {
    console.error('[predict_complex] pae download failed: HTTP', dl.status)
    return undefined
  }
  if (typeof dl.arrayBuffer !== 'function') {
    console.error('[predict_complex] pae download skipped: no binary body support')
    return undefined
  }
  const buf = Buffer.from(await dl.arrayBuffer())
  if (buf.length === 0 || buf.length > 16 * 1024 * 1024) {
    console.error('[predict_complex] pae download rejected: size', buf.length)
    return undefined
  }
  return buf
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
        const label = name.replace(/[^A-Za-z0-9_.-]/g, '_')
        // 算力路由第一档：GPU worker（家里机器经反向 SSH 隧道挂在回环端口）。
        // 任何失败（隧道断/忙/算错）都静默落回下面的原链路——保底语义，对前端透明。
        const t0 = Date.now()
        const workerOut = await runWorkerBoltz({ proteins, smiles })
        if (workerOut) {
          return finishBoltzResult({
            tctx,
            proteins,
            smiles,
            singleChain,
            label,
            t0,
            pdbContent: workerOut.pdbContent,
            paeBytes: workerOut.paeNpzB64 ? Buffer.from(workerOut.paeNpzB64, 'base64') : undefined,
            conf: workerOut.conf,
            aff: workerOut.aff,
            engine: 'boltz2-worker',
          })
        }
        const key = resolveApiKey()
        // No key → run the open-source weights locally when the CLI exists.
        if (!key) {
          if (!resolveLocalBoltz()) return fail(SETUP_HINT)
          const out = await runLocalBoltz({ proteins, smiles, label, wait })
          if (out.missing) return fail(SETUP_HINT)
          if (out.error) return fail(out.error)
          // boltz writes pLDDT into the PDB B-factor column, so the existing
          // confidence viewer renders local models without extra work.
          return finishBoltzResult({
            tctx,
            proteins,
            smiles,
            singleChain,
            label,
            t0,
            pdbContent: await readFile(out.modelPdb, 'utf8'),
            paeBytes: out.paeNpz ? await readFile(out.paeNpz) : undefined,
            conf: out.conf,
            aff: out.aff,
            engine: 'boltz2-local',
            paeMissingNote: out.paeNpz ? undefined : 'no pae_*.npz found next to the model; heatmap hidden',
          })
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
        // files[0] is the model download — unless the API lists the PAE npz
        // first, so pick the first non-PAE entry for the structure.
        const pdbEntry = (files ?? []).find((f) => !isPaeEntry(f))
        const pdbUrl = pdbEntry?.url ?? pdbEntry
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
        // PAE pickup (defensive — see fetchApiPae): heatmap data when the API
        // exposes it, silence when it doesn't.
        const paeBytes = await fetchApiPae(tctx, files)
        if (paeBytes) {
          const paePath = await writePaeBestEffort(tctx, label, paeBytes)
          if (paePath) report.paePath = paePath
        }
        return result(report, JSON.stringify(report))
      },
    })
  },
}
