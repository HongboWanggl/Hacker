// analyze_confidence multi-chain coverage — extractPlddt used to dedupe on
// resNum alone (dropping colliding chains of Boltz-2 complex PDBs) and sort
// flat, interleaving chains. Segments must not span a chain break and get a
// chain prefix in multi-chain files; single-chain output is unchanged.
import { analyzeConfidence } from '/Users/wanghanbao/agnes-harness/examples/packages/protein-predictor/index.mjs'

const captured: any[] = []
analyzeConfidence.apply({ extension: () => ({ registerTool: (t: any) => captured.push(t) }) })
const spec = captured.find((t) => t.name === 'analyze_confidence')
if (!spec) throw new Error('analyze_confidence not registered')

const ok = (name: string, cond: boolean, extra = '') => {
  console.log(cond ? 'ok ' : 'FAIL', name, extra)
  if (!cond) process.exitCode = 1
}

const mkTctx = (pdb: string) => {
  const written = new Map<string, string>()
  return {
    tctx: { fs: { read: async () => Buffer.from(pdb), write: async (p: string, d: any) => written.set(p, String(d)) } },
    written,
  }
}
const line = (serial: number, chain: string, n: number, aa: string, b: number) =>
  `ATOM  ${String(serial).padStart(5)}  CA  ${aa} ${chain}${String(n).padStart(4)}    ${'0.000'.padStart(8)}${'0.000'.padStart(8)}${'0.000'.padStart(8)}  1.00${b.toFixed(2).padStart(6)}           C`

// --- 1. two chains, both numbered 1-5, low-pLDDT run 2-4 in each
{
  const rows: string[] = []
  let serial = 0
  const mk = (chain: string, bs: number[]) => bs.forEach((b, k) => rows.push(line(++serial, chain, k + 1, 'ALA', b)))
  mk('A', [95, 40, 35, 45, 92])
  mk('B', [88, 55, 30, 60, 90])
  const { tctx, written } = mkTctx(rows.join('\n') + '\n')
  const res = await spec.execute({ pdb_path: 'structures/cplx_boltz.pdb' }, tctx)
  const r = res.structured ?? {}
  ok('no chains dropped', r.residues === 10)
  ok('mean over all 10 residues', r.meanPlddt === 63)
  ok('segments chain-prefixed and per-chain', JSON.stringify(r.lowConfidenceSegments.map((s: any) => s.residues)) === '["A:2-4","B:2-4"]')
  ok('segment chain field', r.lowConfidenceSegments.every((s: any) => s.chain === 'A' || s.chain === 'B'))
  ok('segment length correct', r.lowConfidenceSegments.every((s: any) => s.length === 3))
  ok('report saved', (written.get('reports/cplx_boltz.confidence.json') ?? '').includes('"A:2-4"'))
}

// --- 2. single-chain regression: bare segment strings, gap in numbering
{
  const pdb = [95, 40, 35, 45, 92].map((b, k) => line(k + 1, 'A', k + 20, 'ALA', b)).join('\n')
  const { tctx } = mkTctx(pdb)
  const res = await spec.execute({ pdb_path: 'structures/single.pdb' }, tctx)
  const r = res.structured ?? {}
  ok('legacy bare segment string', r.lowConfidenceSegments?.[0]?.residues === '21-23')
  ok('no chain field on single chain', r.lowConfidenceSegments?.every((s: any) => s.chain === undefined))
  ok('legacy residues count', r.residues === 5)
}

// --- 3. chain break splits a low run even when residue numbers continue
{
  // A:1-3 low, B:4-6 low — flat parsing would call this one 6-residue segment
  const rows = [
    line(1, 'A', 1, 'ALA', 40), line(2, 'A', 2, 'ALA', 35), line(3, 'A', 3, 'ALA', 45),
    line(4, 'B', 4, 'ALA', 50), line(5, 'B', 5, 'ALA', 30), line(6, 'B', 6, 'ALA', 45),
  ].join('\n')
  const { tctx } = mkTctx(rows)
  const res = await spec.execute({ pdb_path: 'structures/broken.pdb' }, tctx)
  const r = res.structured ?? {}
  ok('chain break ends segment', JSON.stringify(r.lowConfidenceSegments.map((s: any) => s.residues)) === '["A:1-3","B:4-6"]')
}

console.log('CONFIDENCE MULTICHAIN TESTS DONE')
process.exit(process.exitCode ?? 0)
