// Unit test compare_structures: math cross-check vs kabsch synthetic, error paths.

import { kabsch } from '../protein-predictor/alphafold.mjs'
import { compareStructures } from '../protein-predictor/pairwise.mjs'

// Structural types for the mocked tool surface (tsx strips these; they exist
// so `biome check` passes without any-casts on dev-test stubs).
type Compared = {
  caRmsd: number
  overlappingResidues: number
  meanAbsPlddtDelta: number
  superposition?: { q?: unknown }
  deltaSeries: { length: number }
  reportPath?: string
  verdict: string
}
type Structured = { compared: Compared; pairwise: { labels: string[] } }
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
compareStructures.apply({ extension: () => ({ registerTool: (t: ToolSpec) => captured.push(t) }) })
const spec = captured.find((t) => t.name === 'compare_structures')
if (!spec) throw new Error('tool not registered')

// synthetic workspace: two PDBs, B = A rotated/translated + pLDDT noise
function pdb(points: number[][], plddt: number[]) {
  let out = ''
  points.forEach((p, i) => {
    out += `ATOM  ${String(i + 1).padStart(5)}  CA  ALA A${String(i + 1).padStart(4)}    ${p.map((v) => v.toFixed(3).padStart(8)).join('')}  1.00${plddt[i].toFixed(2).padStart(6)}           C  \n`
  })
  return out
}
const R = [
  [0.36, -0.48, 0.8],
  [0.8, 0.6, 0],
  [-0.48, 0.64, 0.6],
]
const t = [4.5, -2.25, 9.125]
const base: number[][] = []
for (let i = 0; i < 60; i++) base.push([Math.sin(i * 0.3) * 5, i * 0.55, Math.cos(i * 0.3) * 5])
const moved = base.map((p) =>
  R.map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + t.reduce((s, v) => s + v, 0) / 3),
)
const plddtA = base.map((_, i) => 60 + (i % 40))
const plddtB = base.map((_, i) => 80 - (i % 30))

const files = new Map<string, string>([
  ['structures/a.pdb', pdb(base, plddtA)],
  ['structures/b.pdb', pdb(moved, plddtB)],
])
const tctx = {
  fs: {
    read: async (p: string) => {
      const v = files.get(p)
      if (v === undefined) throw new Error(`not found: ${p}`)
      return new TextEncoder().encode(v)
    },
    write: async (p: string, data: unknown) => {
      files.set(p, typeof data === 'string' ? data : Buffer.from(data as Uint8Array).toString('utf8'))
    },
  },
}

// sanity: exact rigid transform must give ~0 RMSD
const k = kabsch(base, moved)
console.log('kabsch rigid RMSD (expect ~0):', k.rmsd)

const res = await spec.execute(
  {
    structure_a: 'structures/a.pdb',
    structure_b: 'structures/b.pdb',
    label_a: 'WT',
    label_b: 'rigid-copy',
    save_report: true,
  },
  tctx,
)
const r = res.structured
const ok = (name: string, cond: boolean) => console.log(cond ? 'ok ' : 'FAIL', name)
ok('not error', !res.isError)

// Degenerate clouds (the reason the solver is cyclic Jacobi, not power iteration):
// on planar/collinear sets λ1 ≈ |λ4| and power iteration stalls on a mixed vector,
// corrupting the recovered rotation. Both must still superpose to ~0 RMSD.
const rigid = (pts: number[][], Rm: number[][], tv: number[]) =>
  pts.map((p) => Rm.map((r) => r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + tv.reduce((s, v) => s + v, 0) / 3))
ok('kabsch rigid RMSD ~0', k.rmsd < 0.01)
const planar: number[][] = []
for (let i = 0; i < 50; i++)
  planar.push([Math.cos(i * 0.5) * (1 + i * 0.1), Math.sin(i * 0.5) * (1 + i * 0.1), 0])
const kp = kabsch(planar, rigid(planar, R, [3, -7, 2]))
console.log('kabsch planar RMSD (expect ~0):', kp.rmsd)
ok('kabsch planar RMSD ~0', kp.rmsd < 0.01)
const collinear: number[][] = []
for (let i = 0; i < 40; i++) collinear.push([i * 1.7 + Math.sin(i) * 0.001, 0, 0])
const kc = kabsch(collinear, rigid(collinear, R, [-5, 8, 1]))
console.log('kabsch collinear RMSD (expect ~0):', kc.rmsd)
ok('kabsch collinear RMSD ~0', kc.rmsd < 0.01)
ok('rigid RMSD ~0 (<0.01)', r.compared.caRmsd < 0.01)
ok('overlap 60', r.compared.overlappingResidues === 60)
ok('meanAbsDelta expected', Math.abs(r.compared.meanAbsPlddtDelta - 15.3) < 0.6)
ok('labels in report', r.pairwise.labels[0] === 'WT' && r.pairwise.labels[1] === 'rigid-copy')
ok('superposition present', !!r.compared.superposition?.q)
ok('deltaSeries <=80 bins', r.compared.deltaSeries.length <= 80 && r.compared.deltaSeries.length >= 1)
ok('report saved', typeof r.compared.reportPath === 'string')
console.log('verdict:', r.compared.verdict)

// error paths
const miss = await spec.execute({ structure_a: 'structures/a.pdb', structure_b: 'structures/none.pdb' }, tctx)
ok('missing file → isError', miss.isError === true)
const short = await spec.execute(
  { structure_a: 'structures/a.pdb', structure_b: 'structures/short.pdb' },
  {
    fs: {
      read: async (p: string) =>
        new TextEncoder().encode(
          p.endsWith('short.pdb') ? pdb(base.slice(0, 5), plddtA.slice(0, 5)) : files.get(p),
        ),
    },
  },
)
// 5-residue fixture hits the size guard before the overlap guard; the overlap
// refusal itself is covered by pairwise-overlap.mts.
ok('invalid second structure → isError', short.isError === true)
console.log('short msg:', String(short.content[0].text).slice(0, 120))
