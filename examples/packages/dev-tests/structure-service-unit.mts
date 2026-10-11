// protein.structure service unit tests — chain-aware parsing. Boltz-2 complex
// PDBs restart residue numbering at 1 per chain; the old resNum-only dedupe
// dropped every colliding chain, and a flat i-sort interleaved them.
import { runtime } from '/Users/wanghanbao/agnes-harness/examples/packages/protein-view/extensions/main/index.mjs'

// Structural type for the registered service def (tsx strips this; it exists
// so `biome check` passes without any-casts on the dev-test stub).
type Residue = { i: number; chain: string; b: number; aa?: string }
type LigandAtom = { x: number; y: number; z: number; el: string }
type SvcDef = {
  name: string
  handler: (
    args: Record<string, unknown>,
    ctx: unknown,
  ) => Promise<{
    n: number
    sequence: string
    residues: Residue[]
    ligandAtoms?: LigandAtom[]
    ligandBonds?: number[][]
  }>
}
const registered: SvcDef[] = []
runtime.apply({ services: { register: (s: SvcDef) => registered.push(s) } })
const svc = registered.find((s) => s.name === 'protein.structure')
if (!svc) throw new Error('protein.structure not registered')

const ok = (name: string, cond: boolean, extra = '') => {
  console.log(cond ? 'ok ' : 'FAIL', name, extra)
  if (!cond) process.exitCode = 1
}

const mkSvcCtx = (pdb: string) => ({ fs: { read: async () => Buffer.from(pdb) }, cwd: '/ws/' })

// --- 1. multi-chain complex: interleaved file order, both chains numbered 1..3
{
  const lines: string[] = []
  const coords = [
    ['A', 1, 'MET', 0, 0, 0, 90],
    ['B', 1, 'ALA', 50, 0, 0, 85],
    ['A', 2, 'GLU', 3.8, 0, 0, 88],
    ['B', 2, 'GLY', 53.8, 0, 0, 80],
    ['A', 3, 'LYS', 7.6, 0, 0, 91],
    ['B', 3, 'SER', 57.6, 0, 0, 70],
  ] as const
  for (const [ch, n, aa, x, y, z, b] of coords) {
    lines.push(
      `ATOM  ${String(lines.length + 1).padStart(5)}  CA  ${aa} ${ch}${String(n).padStart(4)}    ${x.toFixed(3).padStart(8)}${y.toFixed(3).padStart(8)}${z.toFixed(3).padStart(8)}  1.00${(b / 100).toFixed(2).padStart(6)}           C`,
    )
  }
  const out = await svc.handler({ path: 'structures/cplx.pdb' }, mkSvcCtx(`${lines.join('\n')}\n`))
  ok('no chains dropped', out.n === 6)
  ok(
    'chain order preserved (A block then B)',
    out.residues.map((r) => `${r.chain}${r.i}`).join(',') === 'A1,A2,A3,B1,B2,B3',
  )
  ok(
    'chain field present',
    out.residues.every((r) => r.chain === 'A' || r.chain === 'B'),
  )
  ok('0-1 pLDDT normalized', out.residues[0].b === 90 && out.residues[5].b === 70)
  ok('sequence from all chains', out.sequence === 'MEKAGS')
}

// --- 2. single-chain regression: blank chain column, numbering gap (mature protein)
{
  const pdb = [
    'ATOM      1  CA  ALA A  20      11.111  22.222  33.333  1.00 85.00           C',
    'ATOM      2  CA  GLY A  22      12.111  22.222  33.333  1.00 84.00           C',
    'ATOM      3  CA  GLY A  21      13.111  22.222  33.333  1.00 70.00           C',
  ].join('\n')
  const out = await svc.handler({ path: 'structures/mature.pdb' }, mkSvcCtx(pdb))
  ok('legacy numbering kept as i', out.residues.map((r) => r.i).join(',') === '20,21,22')
  ok(
    'blank chain defaults to A',
    out.residues.every((r) => r.chain === 'A'),
  )
  ok(
    'single-chain not multi-flagged',
    out.residues.every((r) => r.chain === out.residues[0].chain),
  )
}

// --- 3. duplicate (chain, resNum) still deduped; invalid coords skipped
{
  const pdb = [
    'ATOM      1  CA  ALA A   1      11.111  22.222  33.333  1.00 85.00           C',
    'ATOM      2  CA  ALA A   1      99.999  99.999  99.999  1.00 10.00           C',
    'ATOM      3  CA  GLY B   1      notnum  22.222  33.333  1.00 84.00           C',
    'ATOM      4  CA  GLY B   1      14.111  22.222  33.333  1.00 84.00           C',
  ].join('\n')
  const out = await svc.handler({ path: 'structures/dup.pdb' }, mkSvcCtx(pdb))
  ok('dup within chain deduped, bad coords skipped', out.n === 2 && out.residues[1].b === 84)
}

// --- 4. ligand: HETATM parsed with elements + distance bonds, waters skipped
{
  const pdb = [
    'ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00 85.00           C',
    'ATOM      2  CA  GLY A   2       3.800   0.000   0.000  1.00 84.00           C',
    // aspirin-ish: two bonded carbons, an O 1.4 Å away, a water, a far C
    'HETATM    3  C1  LIG B   1      10.000  10.000  10.000  1.00 60.00           C',
    'HETATM    4  C2  LIG B   1      11.300  10.000  10.000  1.00 60.00           C',
    'HETATM    5  O1  LIG B   1      11.900  10.900  10.000  1.00 57.00           O',
    'HETATM    6  O2  HOH B   2      11.000  11.000  11.000  1.00 30.00           O',
    'HETATM    7  C9  LIG B   1      99.000  99.000  99.000  1.00 60.00           C',
  ].join('\n')
  const out = await svc.handler({ path: 'structures/lig.pdb' }, mkSvcCtx(pdb))
  ok('ligand parsed', out.ligandAtoms?.length === 4)
  ok(
    'water excluded',
    out.ligandAtoms.every((a) => !(a.x === 11 && a.y === 11 && a.z === 11)),
  )
  ok('elements from column 77-78', out.ligandAtoms[0].el === 'C' && out.ligandAtoms[2].el === 'O')
  ok('coords rounded', out.ligandAtoms[1].x === 11.3)
  const hasBond = out.ligandBonds.some((b) => b[0] === 0 && b[1] === 1)
  const oBond = out.ligandBonds.some((b) => b[0] === 1 && b[1] === 2)
  ok('distance bonds inferred (C-C and C-O)', hasBond && oBond)
  ok('far atom unbonded', !out.ligandBonds.some((b) => b[1] === 3 || b[0] === 3))
  ok('protein residues unaffected', out.n === 2)
  ok(
    'no ligand key without HETATM',
    !(await svc.handler({ path: 'structures/x.pdb' }, mkSvcCtx(pdb.split('HETATM')[0]))).ligandAtoms,
  )
}

// --- 5. ligand atom cap at 400 (strict PDB columns: name 13-16, resName 18-20,
// x/y/z 31-54, element 77-78 — long names must not shift the coords)
{
  const lines: string[] = ['ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00 85.00           C']
  for (let k = 0; k < 405; k++) {
    lines.push(
      'HETATM ' +
        String(k + 2).padStart(5) +
        `C${k}`.padStart(4) +
        ' LIG B' +
        String(1).padStart(4) +
        '    ' +
        (k * 3).toFixed(3).padStart(8) +
        (0).toFixed(3).padStart(8) +
        (0).toFixed(3).padStart(8) +
        '  1.00 60.00          C  ',
    )
  }
  const out = await svc.handler({ path: 'structures/cap.pdb' }, mkSvcCtx(lines.join('\n')))
  ok('ligand capped at 400 atoms', out.ligandAtoms?.length === 400)
}

console.log('STRUCTURE SERVICE TESTS DONE')
process.exit(process.exitCode ?? 0)
