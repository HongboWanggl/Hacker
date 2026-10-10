// Compare any two structures already in the workspace — wild-type vs mutant,
// two constructs, or a prediction vs the AlphaFold reference saved by
// compare_alphafold. Same geometry engine as compare_alphafold (Horn quaternion
// superposition, exported from alphafold.mjs), matched by residue number so
// truncated constructs only align on the shared range.
//
// The report mirrors compare_alphafold's shape (prediction / alphafold /
// compared) so the workbench panel renders it with the same comparison card;
// `pairwise.labels` tells the panel to use generic names instead of
// "ESMFold / AlphaFold DB".

import { parseCA, normalizePlddt, meanPlddt, kabsch, rmsdVerdict } from './alphafold.mjs'

const Kind = Symbol.for('TypeBox.Kind')

const text = (s) => ({ content: [{ type: 'text', text: s }] })
const result = (structured, s) => ({ content: [{ type: 'text', text: JSON.stringify(structured) }], structured })
const fail = (s) => ({ ...text(s), isError: true })

const str = (desc, extra = {}) => ({ [Kind]: 'String', type: 'string', description: desc, ...extra })
const bool = (desc) => ({ [Kind]: 'Boolean', type: 'boolean', description: desc })

// Reads two workspace files, optionally writes a report: not read-only, but
// non-destructive and idempotent.
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

async function readPdb(tctx, path) {
  let bytes
  try {
    bytes = await tctx.fs.read(path)
  } catch {
    return undefined
  }
  return Buffer.from(bytes).toString('utf8')
}

// Binned signed mean ΔpLDDT for the panel sparkline (same binning as alphafold.mjs).
function deltaSeries(common, deltas, binSize) {
  const series = []
  for (let i = 0; i < common.length; i += binSize) {
    const slice = deltas.slice(i, i + binSize)
    series.push({
      residue: common[i],
      delta: Math.round((slice.reduce((s, d) => s + d, 0) / slice.length) * 10) / 10,
    })
  }
  return series
}

export const compareStructures = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()
    agnes.registerTool({
      name: 'compare_structures',
      description:
        'Compare two PDB structures from the workspace (e.g. wild-type vs mutant, two constructs, or a prediction vs an AlphaFold reference): per-residue pLDDT differences, CA-RMSD after optimal superposition (full chain and pLDDT>=70 core). Residues are matched by number; only the shared range is compared.',
      parameters: {
        [Kind]: 'Object',
        type: 'object',
        properties: {
          structure_a: str('Workspace path of the first (main) PDB, e.g. structures/p53_wt_393aa.pdb'),
          structure_b: str('Workspace path of the second (reference/ghost) PDB'),
          label_a: str('Short label for the first structure in the panel (default: file name)'),
          label_b: str('Short label for the second structure in the panel (default: file name)'),
          save_report: bool('Write reports/<name>.vs-<name>.compare.json (default false)'),
        },
        required: ['structure_a', 'structure_b'],
        additionalProperties: false,
      },
      meta,
      async execute({ structure_a, structure_b, label_a, label_b, save_report = false }, tctx) {
        const pdbA = await readPdb(tctx, structure_a)
        if (pdbA === undefined) return fail(`Cannot read ${structure_a}. Pass workspace paths exactly as returned by predict_structure / compare_alphafold.`)
        const pdbB = await readPdb(tctx, structure_b)
        if (pdbB === undefined) return fail(`Cannot read ${structure_b}. Pass workspace paths exactly as returned by predict_structure / compare_alphafold.`)

        const a = parseCA(pdbA)
        const b = parseCA(pdbB)
        if (a.size < 10 || b.size < 10) {
          return fail(`Too few CA atoms (${a.size} / ${b.size}); are these PDB files with ATOM records?`)
        }
        normalizePlddt(a)
        normalizePlddt(b)

        const nameA = label_a?.trim() || structure_a.split('/').pop()
        const nameB = label_b?.trim() || structure_b.split('/').pop()

        const common = [...a.keys()].filter((r) => b.has(r)).sort((x, y) => x - y)
        if (common.length < 10) {
          return fail(
            `Only ${common.length} residue numbers overlap between ${nameA} (${a.size} residues) and ${nameB} (${b.size} residues). Residues are matched by number — these structures likely use different numbering, so a meaningful alignment is not possible.`,
          )
        }
        const overlapNote =
          common.length < a.size || common.length < b.size
            ? ` (matched ${common.length} of ${a.size}/${b.size} residues by number)`
            : ''

        const deltas = common.map((r) => Math.round((a.get(r).plddt100 - b.get(r).plddt100) * 10) / 10)
        const meanAbsDelta = Math.round((deltas.reduce((s, d) => s + Math.abs(d), 0) / deltas.length) * 10) / 10
        const largestDeltas = common
          .map((residue, i) => ({ residue, delta: deltas[i] }))
          .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
          .slice(0, 5)
          .sort((x, y) => x.residue - y.residue)
        const binSize = Math.max(1, Math.ceil(common.length / 80))
        const series = deltaSeries(common, deltas, binSize)

        // A is the fixed target, B is rotated onto it (ghost in the panel).
        const sup = kabsch(
          common.map((r) => { const p = a.get(r); return [p.x, p.y, p.z] }),
          common.map((r) => { const p = b.get(r); return [p.x, p.y, p.z] }),
        )

        // Core RMSD over residues both models call confidently.
        const coreCommon = common.filter((r) => a.get(r).plddt100 >= 70 && b.get(r).plddt100 >= 70)
        let core
        if (coreCommon.length >= 10) {
          const supCore = kabsch(
            coreCommon.map((r) => { const p = a.get(r); return [p.x, p.y, p.z] }),
            coreCommon.map((r) => { const p = b.get(r); return [p.x, p.y, p.z] }),
          )
          if (supCore) {
            core = {
              caRmsdCore: supCore.rmsd,
              coreResidues: coreCommon.length,
              coreNote: `核心 RMSD 只统计两侧 pLDDT≥70 的 ${coreCommon.length} 个共有残基${overlapNote}`,
            }
          }
        }

        const report = {
          pairwise: { labels: [nameA, nameB] },
          prediction: { path: structure_a, residues: a.size, meanPlddt: meanPlddt(a) },
          alphafold: { savedTo: structure_b, residues: b.size, meanPlddt: meanPlddt(b) },
          compared: {
            overlappingResidues: common.length,
            meanAbsPlddtDelta: meanAbsDelta,
            largestDeltas,
            deltaSeries: series,
            deltaSeriesNote: binSize > 1 ? `横轴按每 ${binSize} 个残基分箱 · 正值=A 更自信，负值=B 更自信` : '横轴为残基编号 · 正值=A 更自信，负值=B 更自信',
            ...(core ?? {}),
            verdict: sup ? rmsdVerdict(sup.rmsd) + overlapNote : undefined,
            ...(sup ? { caRmsd: sup.rmsd, superposition: sup } : {}),
          },
        }

        let reportPath
        if (save_report) {
          const base = (x) => x.split('/').pop().replace(/\.pdb$/i, '')
          reportPath = `reports/${base(structure_a)}.vs-${base(structure_b)}.compare.json`
          await tctx.fs.write(reportPath, JSON.stringify(report, null, 2))
          report.compared.reportPath = reportPath
        }
        return result(report, JSON.stringify(report))
      },
    })
  },
}
