// Unit probe for the bench scoring math (server/src/lddt.ts): NW alignment,
// Cα-lDDT (superposition-free by construction) and CA-RMSD after Horn
// superposition. Synthetic structures only — no daemon, no network.
import { nwPairs, type ScoreRes, scoreStructures } from '../protein-platform/server/src/lddt.ts'

let n = 0
let bad = 0
const ok = (cond: boolean, label: string) => {
  n++
  if (!cond) {
    bad++
    console.log(`  FAIL ${label}`)
  }
}
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps
// scoreStructures returns undefined for degenerate inputs; these cases all
// expect a real score, so unwrap loudly instead of `!`-asserting everywhere.
const must = (s: ReturnType<typeof scoreStructures>) => {
  if (!s) throw new Error('expected a score, got undefined')
  return s
}

// A deterministic zigzag "backbone": smooth 3D curve so distances vary and the
// inclusion radius (15 Å) covers a realistic neighborhood.
const chain = (f: (i: number) => { x: number; y: number; z: number }, len: number, seq: string): ScoreRes[] =>
  Array.from({ length: len }, (_, i) => ({ aa: seq[i % seq.length], ...f(i) }))
const base = (i: number) => ({ x: i * 1.5, y: Math.sin(i / 3) * 3, z: Math.cos(i / 3) * 3 })

// --- NW alignment ---
{
  const p = nwPairs('ACDEFGH', 'ACDEFGH')
  ok(p.length === 7 && p[0][0] === 0 && p[6][1] === 6, 'nw: identical sequences map 1:1')
  const q = nwPairs('ACDEFGH', 'ACDFGH') // deletion in b
  ok(q.length === 6, 'nw: deletion drops one pair')
  ok(
    q.every(([i, j], k) => k === 0 || (q[k - 1][0] < i && q[k - 1][1] < j)),
    'nw: pairs strictly increasing',
  )
  const r = nwPairs('AAAA', 'AA') // target longer than reference (unmodeled tail)
  ok(r.length === 2, 'nw: overhang gives the shared prefix')
  ok(nwPairs('', 'AC').length === 0, 'nw: empty input → no pairs')
}

// --- identity: model === ref ---
{
  const ref = chain(base, 80, 'ACDEFGHIKLMNPQRSTVWY')
  const s = must(
    scoreStructures(
      ref.map((r) => ({ ...r })),
      ref,
    ),
  )
  ok(near(s.lddt, 1, 1e-9), `identity: lddt=1 (got ${s.lddt})`)
  ok(s.rmsd < 1e-6, `identity: rmsd=0 (got ${s.rmsd})`)
  ok(s.identity === 1 && s.nAligned === 80, 'identity: full coverage')
  ok(
    s.perResidue.length === 80 && s.perResidue.every((r) => near(r.lddt, 1, 1e-9)),
    'identity: per-residue all 1',
  )
}

// --- rigid motion must NOT change lDDT (its selling point) and rmsd must ---
{
  const ref = chain(base, 80, 'ACDEFGHIKLMNPQRSTVWY')
  // rotate 90° about z + translate: rigid motion
  const moved = ref.map((r) => ({ ...r, x: -r.y + 100, y: r.x - 50, z: r.z + 7 }))
  const s = must(scoreStructures(moved, ref))
  ok(near(s.lddt, 1, 1e-9), `rigid: lddt still 1 (got ${s.lddt})`)
  ok(s.rmsd < 1e-4, `rigid: rmsd ~0 after superposition (got ${s.rmsd})`)
}

// --- coordinate noise degrades lddt monotonically ---
{
  const seq = 'ACDEFGHIKLMNPQRSTVWY'
  let seed = 42
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648 - 0.5 // ±0.5
  } // ±0.5
  const ref = chain(base, 100, seq)
  const jitter = (amp: number) =>
    ref.map((r) => ({
      ...r,
      x: r.x + rand() * amp * 2,
      y: r.y + rand() * amp * 2,
      z: r.z + rand() * amp * 2,
    }))
  const s05 = must(scoreStructures(jitter(0.25), ref))
  const s1 = must(scoreStructures(jitter(0.5), ref))
  const s2 = must(scoreStructures(jitter(1.5), ref))
  ok(s05.lddt > 0.95, `noise 0.25: lddt>0.95 (got ${s05.lddt})`)
  ok(s1.lddt < s05.lddt, 'noise: monotone degradation')
  ok(s2.lddt < s1.lddt, 'noise: monotone degradation (2)')
  ok(s1.rmsd > s05.rmsd && s2.rmsd > s1.rmsd, 'noise: rmsd grows too')
}

// --- a locally broken region shows up in per-residue lddt ---
{
  const seq = 'ACDEFGHIKLMNPQRSTVWY'
  const ref = chain(base, 100, seq)
  const local = ref.map((r, i) =>
    i >= 40 && i < 60 ? { ...r, x: r.x + 4, y: r.y + 4, z: r.z + 4 } : { ...r },
  )
  const s = must(scoreStructures(local, ref))
  ok(s.lddt < 0.97 && s.lddt > 0.8, `local shift: global lddt moderately dropped (got ${s.lddt})`)
  const mid = s.perResidue.slice(40, 60)
  const ends = [...s.perResidue.slice(0, 25), ...s.perResidue.slice(75)]
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length
  ok(
    avg(mid.map((r) => r.lddt)) < avg(ends.map((r) => r.lddt)) - 0.15,
    'local shift: per-residue flags the region',
  )
}

// --- pLDDT flows through to the calibration series ---
{
  const ref = chain(base, 60, 'ACDEFGHIKLMNPQRSTVWY').map((r, i) => ({ ...r, b: 30 + i }))
  const s = must(
    scoreStructures(
      ref.map((r) => ({ ...r })),
      ref,
    ),
  )
  ok(
    s.perResidue[0].plddt === 30 && s.perResidue[59].plddt === 89,
    'plddt passthrough: b lands in perResidue',
  )
}

// --- gappy alignment: model missing internal residues still scores the shared ones ---
{
  const seq = 'ACDEFGHIKLMNPQRSTVWY'
  const ref = chain(base, 90, seq)
  const gappy = ref.filter((_, i) => i % 4 !== 2) // every 4th residue unmodeled
  const s = must(scoreStructures(gappy, ref))
  ok(s.nAligned === Math.ceil(90 * 0.75), `gaps: aligned=${s.nAligned} want ${Math.ceil(90 * 0.75)}`)
  ok(s.lddt > 0.95, `gaps: shared-region lddt still high (got ${s.lddt})`)
}

// --- too-different sequences refuse to score (<5 aligned pairs) ---
{
  const a = chain(base, 4, 'A')
  const b = chain(base, 4, 'D')
  ok(scoreStructures(a, b) === undefined, 'mismatch: <5 aligned pairs → undefined')
}

// --- wrong-fold sanity: scrambled coordinates score poorly ---
{
  const ref = chain(base, 120, 'ACDEFGHIKLMNPQRSTVWY')
  let seed = 7
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648 - 0.5 // ±0.5
  }
  const scrambled = ref.map(() => ({ aa: 'A', x: rand() * 80, y: rand() * 80, z: rand() * 80 }))
  const s = must(scoreStructures(scrambled, ref))
  ok(s.lddt < 0.4, `scrambled: lddt collapses (got ${s.lddt})`)
}

console.log(bad === 0 ? `lddt-unit probe: PASS (${n} assertions)` : `lddt-unit probe: ${bad}/${n} FAILED`)
process.exit(bad === 0 ? 0 : 1)
