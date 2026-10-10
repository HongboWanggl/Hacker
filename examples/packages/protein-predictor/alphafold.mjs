// Compare an ESMFold prediction against the AlphaFold DB reference model.
// Resolves the canonical model URL via the AFDB REST API (/api/prediction/{acc},
// field pdbUrl — the file version suffix changes over time, currently v6), then:
//   - per-residue pLDDT agreement (mean absolute delta, worst-drifting segments)
//   - CA-RMSD after superposition (Horn quaternion method; power iteration on the
//     4x4 Horn matrix avoids shipping an SVD implementation)
// Both models must cover the same UniProt numbering for RMSD to be meaningful;
// the tool only superposes the overlapping residue range and says so.

const AFDB = 'https://alphafold.ebi.ac.uk'
const AF_VERSIONS = ['v6', 'v5', 'v4', 'v3', 'v2']

const Kind = Symbol.for('TypeBox.Kind')

const text = (s) => ({ content: [{ type: 'text', text: s }] })
const result = (structured, s) => ({ content: [{ type: 'text', text: JSON.stringify(structured) }], structured })
const fail = (s) => ({ ...text(s), isError: true })

const str = (desc, extra = {}) => ({ [Kind]: 'String', type: 'string', description: desc, ...extra })
const bool = (desc) => ({ [Kind]: 'Boolean', type: 'boolean', description: desc })

// Writes the reference PDB (and optionally the report) into the workspace:
// not read-only, but non-destructive and idempotent.
const meta = {
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: true,
  isOpenWorld: false,
  replay: 'idempotent',
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'never',
}

// resNum -> { x, y, z, plddt } from the first CA line per residue.
export function parseCA(pdb) {
  const map = new Map()
  for (const line of pdb.split('\n')) {
    if (!line.startsWith('ATOM')) continue
    if (line.slice(12, 16).trim() !== 'CA') continue
    const resNum = Number(line.slice(22, 26).trim())
    const x = Number(line.slice(30, 38))
    const y = Number(line.slice(38, 46))
    const z = Number(line.slice(46, 54))
    const b = Number(line.slice(60, 66))
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(b)) continue
    if (!map.has(resNum)) map.set(resNum, { x, y, z, plddt: b })
  }
  return map
}

// Normalize pLDDT to 0-100 (ESMFold writes 0-1, AlphaFold DB writes 0-100).
export function normalizePlddt(map) {
  let max = 0
  for (const r of map.values()) max = Math.max(max, r.plddt)
  if (max > 0 && max <= 1.5) for (const r of map.values()) r.plddt100 = Math.round(r.plddt * 1000) / 10
  else for (const r of map.values()) r.plddt100 = r.plddt
}

export function meanPlddt(map) {
  let s = 0
  for (const r of map.values()) s += r.plddt100
  return Math.round((s / (map.size || 1)) * 10) / 10
}

// Dominant eigenvector of the 4x4 Horn matrix via power iteration (PSD matrix;
// a mixed initial vector keeps us off any orthogonal starting point).
function dominantQuaternion(S) {
  let v = [0.55, 0.41, 0.29, 0.17]
  let norm = Math.hypot(...v)
  v = v.map((x) => x / norm)
  for (let i = 0; i < 200; i++) {
    const w = [
      S[0][0] * v[0] + S[0][1] * v[1] + S[0][2] * v[2] + S[0][3] * v[3],
      S[1][0] * v[0] + S[1][1] * v[1] + S[1][2] * v[2] + S[1][3] * v[3],
      S[2][0] * v[0] + S[2][1] * v[1] + S[2][2] * v[2] + S[2][3] * v[3],
      S[3][0] * v[0] + S[3][1] * v[1] + S[3][2] * v[2] + S[3][3] * v[3],
    ]
    norm = Math.hypot(...w)
    if (norm < 1e-14) break
    v = w.map((x) => x / norm)
  }
  return v // [w, x, y, z] — quaternion rotating Q onto P
}

function quaternionToMatrix(q) {
  const [w, x, y, z] = q
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ]
}

// Optimal superposition of P onto Q (equal-length arrays of [x,y,z]).
// Returns { rmsd, q, pc, qc }: rotate (Q−qc) by quaternion q, then add pc, to
// overlay the source onto the target. Also used by the panel to draw the
// reference as a ghost aligned with the prediction.
export function kabsch(P, Q) {
  const n = P.length
  if (n < 3) return undefined
  const centroid = (pts) => [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / n)
  const pc = centroid(P)
  const qc = centroid(Q)
  // Horn's convention: S_ij = Σ source_i · target_j, with the rotation applied to
  // Q (source) minimizing |P − RQ|. Row index = source component.
  const s = new Array(9).fill(0)
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        s[a * 3 + b] += (Q[i][a] - qc[a]) * (P[i][b] - pc[b])
      }
    }
  }
  const [s1, s2, s3, s4, s5, s6, s7, s8, s9] = s
  // Horn matrix M: dominant eigenvector is the optimal rotation quaternion.
  const M = [
    [s1 + s5 + s9, s6 - s8, s7 - s3, s2 - s4],
    [s6 - s8, s1 - s5 - s9, s2 + s4, s3 + s7],
    [s7 - s3, s2 + s4, -s1 + s5 - s9, s6 + s8],
    [s2 - s4, s3 + s7, s6 + s8, -s1 - s5 + s9],
  ]
  const q = dominantQuaternion(M)
  const R = quaternionToMatrix(q)
  // Compare centered coordinates: rotation came from centered clouds, so the
  // translation (pc − R·qc) must be accounted for here too.
  let sum = 0
  for (let i = 0; i < n; i++) {
    const qx = Q[i][0] - qc[0], qy = Q[i][1] - qc[1], qz = Q[i][2] - qc[2]
    const dx = P[i][0] - pc[0] - (R[0][0] * qx + R[0][1] * qy + R[0][2] * qz)
    const dy = P[i][1] - pc[1] - (R[1][0] * qx + R[1][1] * qy + R[1][2] * qz)
    const dz = P[i][2] - pc[2] - (R[2][0] * qx + R[2][1] * qy + R[2][2] * qz)
    sum += dx * dx + dy * dy + dz * dz
  }
  return {
    rmsd: Math.round(Math.sqrt(sum / n) * 1000) / 1000,
    q: q.map((x) => Math.round(x * 1e6) / 1e6),
    pc: pc.map((x) => Math.round(x * 1e3) / 1e3),
    qc: qc.map((x) => Math.round(x * 1e3) / 1e3),
  }
}

export function rmsdVerdict(rmsd) {
  if (rmsd === undefined) return undefined
  if (rmsd < 2) return 'folds agree closely (CA-RMSD < 2 Å)'
  if (rmsd < 4) return 'same overall fold with local differences (CA-RMSD 2-4 Å)'
  return 'significant deviation (CA-RMSD > 4 Å); inspect the low-confidence regions before comparing details'
}

export const compareAlphafold = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()
    agnes.registerTool({
      name: 'compare_alphafold',
      description:
        'Compare a predicted PDB (from predict_structure or predict_complex) against the AlphaFold DB reference model for a UniProt accession. Reports per-residue pLDDT agreement (mean absolute delta, binned delta profile) and CA-RMSD after superposition, saves the reference model for the panel 3D overlay. Free (no API key needed).',
      parameters: {
        [Kind]: 'Object',
        type: 'object',
        properties: {
          accession: str('UniProt accession of the reference model, e.g. P04637'),
          prediction_path: str('Workspace-relative path of the predicted PDB, e.g. structures/p53_1.pdb'),
          save_report: bool('Also save the comparison as reports/<accession>.vs-alphafold.json (default false)'),
        },
        required: ['accession', 'prediction_path'],
        additionalProperties: false,
      },
      meta,
      async execute({ accession, prediction_path, save_report = false }, tctx) {
        const acc = String(accession).trim().toUpperCase()
        if (!/^[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]$/.test(acc)) {
          return fail(`"${acc}" does not look like a UniProt accession.`)
        }

        // Resolve the canonical model URL. The REST API knows the current file
        // version (it changes over time — currently v6); fall back to probing
        // known version suffixes if the API is unreachable.
        let afPdb
        let usedVersion
        let apiMeta
        try {
          const apiRes = await tctx.net.fetch(`${AFDB}/api/prediction/${acc}`, { timeoutMs: 60000 })
          if (apiRes.ok) {
            const entries = await apiRes.json()
            apiMeta = Array.isArray(entries) ? entries[0] : undefined
            if (apiMeta?.pdbUrl) {
              const dl = await tctx.net.fetch(apiMeta.pdbUrl, { timeoutMs: 120000 })
              if (dl.ok) {
                afPdb = await dl.text()
                usedVersion = apiMeta.pdbUrl.match(/model_(v\d+)/)?.[1]
              }
            }
          }
        } catch {
          // Fall through to direct file probing.
        }
        for (const version of AF_VERSIONS) {
          if (afPdb) break
          const url = `${AFDB}/files/AF-${acc}-F1-model_${version}.pdb`
          let res
          try {
            res = await tctx.net.fetch(url, { timeoutMs: 60000 })
          } catch (error) {
            return fail(`AlphaFold DB request error: ${String(error).slice(0, 200)}`)
          }
          if (res.ok) {
            afPdb = await res.text()
            usedVersion = version
            break
          }
          if (res.status !== 404) return fail(`AlphaFold DB request failed: HTTP ${res.status}`)
        }
        if (!afPdb) return fail(`No AlphaFold DB model found for ${acc}. Check the accession.`)

        const afMap = parseCA(afPdb)
        normalizePlddt(afMap)
        if (afMap.size === 0) return fail('AlphaFold DB model parsed to zero CA atoms.')

        let predPdb
        try {
          // fs.read returns Bytes (Uint8Array), same contract analyze_confidence uses.
          predPdb = Buffer.from(await tctx.fs.read(prediction_path)).toString('utf8')
        } catch {
          return fail(`Cannot read ${prediction_path}. Run predict_structure first and pass its savedTo path.`)
        }
        const predMap = parseCA(predPdb)
        normalizePlddt(predMap)
        if (predMap.size === 0) return fail(`No CA atoms found in ${prediction_path}.`)

        const common = [...afMap.keys()].filter((r) => predMap.has(r)).sort((a, b) => a - b)
        if (common.length < 3) {
          return result(
            {
              accession: acc,
              model: `AF-${acc}-F1`,
              alphafold: { residues: afMap.size, meanPlddt: meanPlddt(afMap) },
              prediction: { path: prediction_path, residues: predMap.size, meanPlddt: meanPlddt(predMap) },
              note: `Only ${common.length} overlapping residue numbers; prediction and reference likely use different numbering. No comparison computed.`,
            },
            'residue numbering mismatch',
          )
        }

        const deltas = common.map((r) => ({ residue: r, delta: Math.round((predMap.get(r).plddt100 - afMap.get(r).plddt100) * 10) / 10 }))
        const meanAbsDelta = Math.round((deltas.reduce((s, d) => s + Math.abs(d.delta), 0) / deltas.length) * 10) / 10
        const worst = [...deltas].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 5)
        // Downsample to ≤80 equal-size bins (signed mean per bin) so the browser
        // card can draw a compact ΔpLDDT profile without hauling every residue.
        const BIN_MAX = 80
        const binSize = Math.ceil(deltas.length / BIN_MAX)
        const deltaSeries = deltas.reduce((bins, d, i) => {
          const b = Math.floor(i / binSize)
          if (!bins[b]) bins[b] = { residue: d.residue, sum: 0, n: 0 }
          bins[b].sum += d.delta
          bins[b].n++
          return bins
        }, []).map((b) => ({ residue: b.residue, delta: Math.round((b.sum / b.n) * 10) / 10 }))

        const sup = kabsch(
          common.map((r) => { const p = predMap.get(r); return [p.x, p.y, p.z] }),
          common.map((r) => { const p = afMap.get(r); return [p.x, p.y, p.z] }),
        )
        const rmsd = sup?.rmsd
        // Core RMSD: superposition restricted to residues both models call
        // confidently (pLDDT >= 70). Whole-chain RMSD is inflated by disordered
        // tails where every model disagrees by design.
        const core = common.filter((r) => predMap.get(r).plddt100 >= 70 && afMap.get(r).plddt100 >= 70)
        const coreRmsd = core.length >= 10
          ? kabsch(
              core.map((r) => { const p = predMap.get(r); return [p.x, p.y, p.z] }),
              core.map((r) => { const p = afMap.get(r); return [p.x, p.y, p.z] }),
            )?.rmsd
          : undefined

        const report = {
          accession: acc,
          model: `AF-${acc}-F1${usedVersion ? ` (${usedVersion})` : ''}`,
          alphafold: {
            residues: afMap.size,
            meanPlddt: meanPlddt(afMap),
            ...(apiMeta?.globalMetricValue !== undefined ? { dbMeanPlddt: apiMeta.globalMetricValue } : {}),
            ...(apiMeta?.modelCreatedDate ? { modelDate: apiMeta.modelCreatedDate.slice(0, 10) } : {}),
          },
          prediction: { path: prediction_path, residues: predMap.size, meanPlddt: meanPlddt(predMap) },
          compared: {
            overlappingResidues: common.length,
            meanAbsPlddtDelta: meanAbsDelta,
            largestDeltas: worst,
            deltaSeries,
            deltaSeriesNote: 'ΔpLDDT profile (prediction − reference), ≤80 bins; positive = ESMFold more confident',
            caRmsd: rmsd,
            // Transform for the panel's 3D overlay: AF CA p → R·(p − qc) + pc.
            ...(sup ? { superposition: { q: sup.q, pc: sup.pc, qc: sup.qc } } : {}),
            ...(coreRmsd !== undefined
              ? { caRmsdCore: coreRmsd, coreResidues: core.length, coreNote: 'RMSD over residues where both models have pLDDT ≥ 70' }
              : {}),
            ...(rmsd !== undefined ? { verdict: rmsdVerdict(coreRmsd ?? rmsd) } : {}),
          },
        }
        // Persist the reference model so the panel can render the overlay.
        try {
          const refPath = `structures/${acc}_alphafold_ref.pdb`
          await tctx.fs.write(refPath, afPdb)
          report.alphafold.savedTo = refPath
        } catch {
          // Overlay degrades to metrics-only when the workspace rejects writes.
        }
        if (meanAbsDelta < 5 && (coreRmsd ?? rmsd) !== undefined && (coreRmsd ?? rmsd) < 2) {
          report.compared.confidenceAgreement = 'the two models agree on both fold and confidence profile'
        }

        if (save_report) {
          try {
            await tctx.fs.write(`reports/${acc}.vs-alphafold.json`, JSON.stringify(report, null, 2))
            report.savedTo = `reports/${acc}.vs-alphafold.json`
          } catch {
            // Report-only output is fine if the workspace rejects writes.
          }
        }
        return result(report, JSON.stringify(report))
      },
    })
  },
}
