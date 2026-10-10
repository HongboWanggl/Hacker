// @aghes/protein-predictor — protein structure prediction tools for Agnes Harness.
// Pipeline: UniProt sequence -> ESMFold prediction -> pLDDT confidence analysis.
// Boltz-2 (boltz.mjs) adds paid complex/ligand co-folding with interface confidences.

import { predictComplex } from './boltz.mjs'
import { compareAlphafold } from './alphafold.mjs'
import { compareStructures } from './pairwise.mjs'
import { batchPredictor } from './batch.mjs'

const Kind = Symbol.for('TypeBox.Kind')

const str = (desc, extra = {}) => ({ [Kind]: 'String', type: 'string', description: desc, ...extra })
const num = (desc, extra = {}) => ({ [Kind]: 'Number', type: 'number', description: desc, ...extra })

const AA_RE = /^[ACDEFGHIKLMNPQRSTVWYBXZUO]+$/i
const ESMFOLD_URL = 'https://api.esmatlas.com/foldSequence/v1/pdb/'
const UNIPROT = 'https://rest.uniprot.org/uniprotkb'

const readOnlyMeta = {
  isReadOnly: true,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'safe',
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'never',
}

// Network + workspace writes: not read-only; defaults to approval-free since non-destructive.
// Production deployments should tighten this (requiresApproval/classify) per security policy.
const writeMeta = {
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'idempotent',
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'never',
}

const text = (s) => ({ content: [{ type: 'text', text: s }] })
const result = (structured, s) => ({ content: [{ type: 'text', text: JSON.stringify(structured) }], structured })
const fail = (s) => ({ ...text(s), isError: true })

// One retry after a short backoff for transient upstream failures — the free
// shared ESMFold/UniProt endpoints occasionally return 5xx or drop connections.
// Retries network errors and 5xx/429 only; a 4xx (bad accession, bad sequence)
// fails immediately. The second attempt's result (or error) is returned as-is.
export async function fetchRetry(fetchFn, url, opts = {}) {
  try {
    const res = await fetchFn(url, opts)
    if (res.status >= 500 || res.status === 429) {
      await new Promise((r) => setTimeout(r, 1500))
      return fetchFn(url, opts)
    }
    return res
  } catch (error) {
    await new Promise((r) => setTimeout(r, 1500))
    return fetchFn(url, opts)
  }
}

// ---------------------------------------------------------------------------
// Parse a FASTA header: >sp|P04637|P53_HUMAN Cellular tumor antigen p53 OS=Homo sapiens OX=9606 GN=TP53 PE=1 SV=4
function parseFasta(fasta) {
  const lines = fasta.trim().split('\n')
  const header = lines[0].replace(/^>+\s*/, '')
  const parts = header.split('|')
  const db = parts[0]
  const accession = parts[1] ?? header.split(/\s+/)[0]
  const entryName = parts[2] ?? ''
  const desc = parts.length >= 3 ? header.split('|').slice(2).join('|').replace(/^[^ ]+\s*/, '') : header
  const sequence = lines.slice(1).map((l) => l.trim()).join('')
  const grab = (tag) => {
    const m = desc.match(new RegExp(`${tag}=([^;\\s]+)`))
    return m ? m[1] : undefined
  }
  return {
    database: db,
    accession,
    entryName,
    proteinName: desc.replace(/^(sp|tr)\|[^|]*\|[^ ]*\s*/, '').split(/\s+OS=/)[0],
    gene: grab('GN'),
    organism: grab('OS'),
    sequence,
    length: sequence.length,
  }
}

// ---------------------------------------------------------------------------
// Tool 1: uniprot_search — keyword search over UniProtKB (read-only, keyless).
export const uniprotSearch = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()
    agnes.registerTool({
      name: 'uniprot_search',
      description:
        'Search UniProtKB for proteins by keyword, gene name, organism, etc. Returns accessions and metadata. Use before uniprot_fetch when you only have a name, not an accession.',
      parameters: {
        [Kind]: 'Object',
        type: 'object',
        properties: {
          query: str('UniProt search query, e.g. "gene:TP53 AND organism_id:9606" or "insulin human"'),
          limit: num('Max results (1-25, default 5)', { minimum: 1, maximum: 25 }),
        },
        required: ['query'],
        additionalProperties: false,
      },
      meta: readOnlyMeta,
      async execute({ query, limit = 5 }, tctx) {
        const url = `${UNIPROT}/search?query=${encodeURIComponent(query)}&format=tsv&fields=accession,id,protein_name,organism_name,length&size=${limit}`
        const res = await fetchRetry(tctx.net.fetch, url, { timeoutMs: 30000 })
        if (!res.ok) return fail(`UniProt search failed: HTTP ${res.status}`)
        const body = await res.text()
        const lines = body.trim().split('\n')
        if (lines.length <= 1) return result({ query, hits: [] }, 'no hits')
        const hits = lines.slice(1).map((l) => {
          const [accession, id, proteinName, organism, length] = l.split('\t')
          return { accession, id, proteinName, organism, length: Number(length) }
        })
        // Save the full report and put savedTo FIRST in the structured result: the
        // transcript clips resultPreview at 4096 chars, and with >20 hits the JSON tail
        // (where savedTo would land) is cut — the panel then cannot find the full copy.
        const slug = query.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'query'
        const reportPath = `reports/search_${slug}.json`
        await tctx.fs.write(reportPath, JSON.stringify({ query, hits }, null, 2))
        return result({ savedTo: reportPath, query, hits }, JSON.stringify({ savedTo: reportPath, query, hits }))
      },
    })
  },
}

// ---------------------------------------------------------------------------
// Tool 2: uniprot_fetch — fetch a sequence by accession (read-only, keyless).
export const uniprotFetch = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()
    agnes.registerTool({
      name: 'uniprot_fetch',
      description:
        'Fetch a protein sequence in FASTA format from UniProt by accession (e.g. P04637) and save it to sequences/<accession>.fasta in the workspace.',
      parameters: {
        [Kind]: 'Object',
        type: 'object',
        properties: { accession: str('UniProtKB accession, e.g. P04637') },
        required: ['accession'],
        additionalProperties: false,
      },
      meta: readOnlyMeta,
      async execute({ accession }, tctx) {
        const acc = accession.trim().toUpperCase()
        if (!/^[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]$/.test(acc)) {
          return fail(`"${accession}" does not look like a UniProtKB accession (e.g. P04637). Use uniprot_search first if you only have a name.`)
        }
        const res = await fetchRetry(tctx.net.fetch, `${UNIPROT}/${acc}.fasta`, { timeoutMs: 30000 })
        if (!res.ok) return fail(`UniProt fetch failed: HTTP ${res.status} for ${acc}`)
        const fasta = await res.text()
        const info = parseFasta(fasta)
        const path = `sequences/${acc}.fasta`
        await tctx.fs.write(path, fasta)
        return result({ ...info, savedTo: path }, JSON.stringify({ ...info, savedTo: path }))
      },
    })
  },
}

// ---------------------------------------------------------------------------
// pLDDT lives in the B-factor column of CA atoms.
function extractPlddt(pdb) {
  const perResidue = new Map()
  const chainOrder = new Map()
  for (const line of pdb.split('\n')) {
    if (!line.startsWith('ATOM')) continue
    const atomName = line.slice(12, 16).trim()
    if (atomName !== 'CA') continue
    const resNum = Number(line.slice(22, 26).trim())
    // Identity is chain + residue number: Boltz-2 complexes restart numbering
    // at 1 per chain, and deduping on resNum alone would drop colliding chains.
    const chain = line.slice(21, 22).trim() || 'A'
    const b = Number(line.slice(60, 66).trim())
    if (!Number.isFinite(b) || !Number.isInteger(resNum)) continue
    const key = `${chain}:${resNum}`
    if (perResidue.has(key)) continue
    perResidue.set(key, b)
    if (!chainOrder.has(chain)) chainOrder.set(chain, chainOrder.size)
  }
  const series = [...perResidue.entries()].map(([key, plddt]) => {
    const at = key.indexOf(':')
    return { chain: key.slice(0, at), residue: Number(key.slice(at + 1)), plddt }
  })
  // Group by chain in file order, then by residue number — never interleave chains.
  series.sort((a, b) => chainOrder.get(a.chain) - chainOrder.get(b.chain) || a.residue - b.residue)
  // ESMFold writes pLDDT on a 0-1 scale; AlphaFold-family writes 0-100. Normalize to 0-100.
  const max = series.reduce((m, r) => Math.max(m, r.plddt), 0)
  if (max > 0 && max <= 1.5) for (const r of series) r.plddt = Math.round(r.plddt * 1000) / 10
  return series
}

function confidenceReport(series) {
  const n = series.length
  const mean = series.reduce((s, r) => s + r.plddt, 0) / (n || 1)
  const bands = { veryHigh: 0, confident: 0, low: 0, veryLow: 0 }
  for (const { plddt } of series) {
    if (plddt > 90) bands.veryHigh++
    else if (plddt >= 70) bands.confident++
    else if (plddt >= 50) bands.low++
    else bands.veryLow++
  }
  // contiguous low-confidence segments (>=3 residues below 70); a chain break
  // always ends a segment so multi-chain complexes never span chains.
  const multiChain = new Set(series.map((r) => r.chain)).size > 1
  const segments = []
  let start = null
  let segChain = null
  for (let i = 0; i <= n; i++) {
    const cur = i < n ? series[i] : null
    const low = cur != null && cur.plddt < 70
    const chainBreak = cur != null && start !== null && cur.chain !== segChain
    if (start !== null && (!low || chainBreak)) {
      const end = series[i - 1].residue
      if (end - start + 1 >= 3) {
        const seg = series.filter((r) => r.chain === segChain && r.residue >= start && r.residue <= end)
        segments.push({
          residues: multiChain ? `${segChain}:${start}-${end}` : `${start}-${end}`,
          ...(multiChain ? { chain: segChain } : {}),
          length: end - start + 1,
          meanPlddt: Math.round((seg.reduce((s, r) => s + r.plddt, 0) / seg.length) * 10) / 10,
        })
      }
      start = null
    }
    if (low && start === null) {
      start = cur.residue
      segChain = cur.chain
    }
  }
  segments.sort((a, b) => a.meanPlddt - b.meanPlddt)
  const pct = (x) => Math.round((x / (n || 1)) * 1000) / 10
  return {
    residues: n,
    meanPlddt: Math.round(mean * 10) / 10,
    bands: {
      veryHigh_gt90: { count: bands.veryHigh, pct: pct(bands.veryHigh) },
      confident_70_90: { count: bands.confident, pct: pct(bands.confident) },
      low_50_70: { count: bands.low, pct: pct(bands.low) },
      veryLow_lt50: { count: bands.veryLow, pct: pct(bands.veryLow) },
    },
    lowConfidenceSegments: segments.slice(0, 8),
    verdict:
      mean >= 90 ? 'high confidence overall'
      : mean >= 70 ? 'backbone mostly reliable; inspect low-confidence segments'
      : 'low overall confidence; treat fold with caution',
  }
}

// ---------------------------------------------------------------------------
// Tool 3: predict_structure — ESMFold via api.esmatlas.com (free, keyless).
export const predictStructure = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()
    agnes.registerTool({
      name: 'predict_structure',
      description:
        'Predict protein 3D structure from an amino-acid sequence using ESMFold (language-model based, no MSA needed, ~seconds). Saves a PDB file with pLDDT confidence in the B-factor column. Best for single chains under ~400 residues.',
      parameters: {
        [Kind]: 'Object',
        type: 'object',
        properties: {
          sequence: str('Amino-acid sequence in single-letter code, e.g. MEEPQSDPSV...'),
          name: str('Short label used for output filenames, e.g. p53_wt (default: prediction)'),
        },
        required: ['sequence'],
        additionalProperties: false,
      },
      meta: writeMeta,
      async execute({ sequence, name = 'prediction' }, tctx) {
        const seq = sequence.replace(/\s+/g, '').toUpperCase()
        if (seq.length < 10) return fail('Sequence too short (<10 residues).')
        if (!AA_RE.test(seq)) return fail('Sequence contains invalid characters. Use single-letter amino-acid code.')
        if (seq.length > 1000) return fail(`Sequence too long (${seq.length} residues); ESMFold endpoint handles short chains (<1000, ideally <400).`)
        const label = name.replace(/[^A-Za-z0-9_.-]/g, '_')
        const res = await fetchRetry(tctx.net.fetch, ESMFOLD_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: seq,
          timeoutMs: 300000,
        })
        if (!res.ok) {
          // The free endpoint rejects long chains outright (413): point the way
          // to the fallback instead of leaving a bare status code.
          const hint =
            res.status === 413 || res.status === 422
              ? ` — chain too long for the free endpoint. For chains of 400+ residues use predict_complex (Boltz-2 folds single chains and runs locally without a key).`
              : ''
          return fail(`ESMFold request failed: HTTP ${res.status}${hint}`)
        }
        const pdb = await res.text()
        if (!pdb.startsWith('HEADER') && !pdb.startsWith('ATOM')) return fail(`ESMFold returned an unexpected response: ${pdb.slice(0, 200)}`)
        const safeName = `${label}_${seq.length}aa.pdb`
        const path = `structures/${safeName}`
        await tctx.fs.write(path, pdb)
        const report = confidenceReport(extractPlddt(pdb))
        return result({ savedTo: path, sequenceLength: seq.length, ...report }, JSON.stringify({ savedTo: path, sequenceLength: seq.length, ...report }))
      },
    })
  },
}

// ---------------------------------------------------------------------------
// Tool 4: analyze_confidence — pLDDT band analysis of a PDB (read-only).
export const analyzeConfidence = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()
    agnes.registerTool({
      name: 'analyze_confidence',
      description:
        'Analyze per-residue confidence (pLDDT from B-factor column) of a predicted PDB: mean score, confidence bands, and the weakest contiguous segments. Optionally saves a JSON report.',
      parameters: {
        [Kind]: 'Object',
        type: 'object',
        properties: {
          pdb_path: str('Workspace path of the PDB file, e.g. structures/p53_wt_393aa.pdb'),
          save_report: { [Kind]: 'Boolean', type: 'boolean', description: 'Write reports/<name>.confidence.json (default true)' },
        },
        required: ['pdb_path'],
        additionalProperties: false,
      },
      meta: readOnlyMeta,
      async execute({ pdb_path, save_report = true }, tctx) {
        let bytes
        try {
          bytes = await tctx.fs.read(pdb_path)
        } catch {
          return fail(`Cannot read ${pdb_path}. Pass the path exactly as returned by predict_structure.`)
        }
        const pdb = Buffer.from(bytes).toString('utf8')
        const series = extractPlddt(pdb)
        if (!series.length) return fail(`No ATOM/B-factor data found in ${pdb_path}.`)
        const report = confidenceReport(series)
        let reportPath
        if (save_report) {
          reportPath = `reports/${pdb_path.split('/').pop().replace(/\.pdb$/, '')}.confidence.json`
          await tctx.fs.write(reportPath, JSON.stringify({ file: pdb_path, ...report }, null, 2))
        }
        return result({ ...report, reportPath }, JSON.stringify({ ...report, reportPath }))
      },
    })
  },
}

// ---------------------------------------------------------------------------
// Single manifest entry registering all protein pipeline tools.
export const proteinPredictor = {
  inject: ['extension'],
  apply(ctx) {
    for (const tool of [uniprotSearch, uniprotFetch, predictStructure, analyzeConfidence, predictComplex, compareAlphafold, compareStructures]) {
      tool.apply(ctx)
    }
    batchPredictor.apply(ctx)
  },
}
