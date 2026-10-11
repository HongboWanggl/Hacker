// Overlap-mismatch: same shape, residue numbering offset by 500 → must refuse.
import { compareStructures } from '/Users/wanghanbao/agnes-harness/examples/packages/protein-predictor/pairwise.mjs'

// Structural types for the mocked tool surface (tsx strips these; they exist
// so `biome check` passes without any-casts on dev-test stubs).
type ToolResult = {
  isError?: boolean
  content?: Array<{ text?: string | { message?: string } }>
}
type ToolSpec = {
  name: string
  execute: (args: Record<string, unknown>, tctx: unknown) => Promise<ToolResult>
}
const captured: ToolSpec[] = []
compareStructures.apply({ extension: () => ({ registerTool: (t: ToolSpec) => captured.push(t) }) })
const spec = captured.find((t) => t.name === 'compare_structures')
function pdb(points: number[][], plddt: number[], start = 1) {
  let out = ''
  points.forEach((p, i) => {
    out += `ATOM  ${String(i + 1).padStart(5)}  CA  ALA A${String(start + i).padStart(4)}    ${p.map((v) => v.toFixed(3).padStart(8)).join('')}  1.00${plddt[i].toFixed(2).padStart(6)}           C  \n`
  })
  return out
}
const base: number[][] = []
for (let i = 0; i < 30; i++) base.push([Math.sin(i * 0.3) * 5, i * 0.55, Math.cos(i * 0.3) * 5])
const plddt = base.map((_, i) => 50 + i)
const files = new Map<string, string>([
  ['structures/a.pdb', pdb(base, plddt)],
  ['structures/shift.pdb', pdb(base, plddt, 500)],
])
const tctx = {
  fs: {
    read: async (p: string) => {
      const v = files.get(p)
      if (!v) throw new Error('missing')
      return new TextEncoder().encode(v)
    },
  },
}
const res = await spec.execute({ structure_a: 'structures/a.pdb', structure_b: 'structures/shift.pdb' }, tctx)
const msg = String(res.content?.[0]?.text ?? '')
console.log(
  res.isError === true && msg.includes('overlap') ? 'ok  numbering mismatch refused' : 'FAIL',
  '::',
  msg.slice(0, 140),
)
