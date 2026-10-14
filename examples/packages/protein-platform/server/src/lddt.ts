// Benchmark scoring math: NW sequence alignment, Cα-lDDT (the CASP/CAMEO headline
// metric, superposition-free by construction) and CA-RMSD after optimal superposition.
// Pure and dependency-free so the unit probe can exercise it against hand-built cases.
//
// The lDDT definition follows Mariani et al. 2013 as used by CASP16/CAMEO: over all
// reference distance pairs within the inclusion radius (15 Å), count how many are
// preserved in the model within each of the four thresholds (0.5/1/2/4 Å); the score
// is the mean of the four preserved fractions. Our variant scores Cα pairs only (the
// platform pipeline is Cα/B-factor based end to end) and only over the residues the
// two structures share — disclosed as Cα-lDDT everywhere it is displayed.

export type ScoreRes = { aa: string; x: number; y: number; z: number; b?: number }

// Global Needleman-Wunsch (match +2 / mismatch -1 / gap -2 — conservative gaps, so
// near-identical CASP sequences align contiguously). Returns matched index pairs
// [iInA, jInB] in alignment order.
export function nwPairs(a: string, b: string): Array<[number, number]> {
  const n = a.length
  const m = b.length
  if (!n || !m) return []
  const GAP = -2
  // Row-major score + traceback tables; targets here are ≤500 residues, no need to
  // get clever about memory.
  const s = new Int32Array((n + 1) * (m + 1))
  const tb = new Uint8Array((n + 1) * (m + 1)) // 0 diag, 1 up (gap in b), 2 left (gap in a)
  for (let j = 1; j <= m; j++) s[j] = j * GAP
  for (let i = 1; i <= n; i++) s[i * (m + 1)] = i * GAP
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const d = s[(i - 1) * (m + 1) + (j - 1)] + (a[i - 1] === b[j - 1] ? 2 : -1)
      const u = s[(i - 1) * (m + 1) + j] + GAP
      const l = s[i * (m + 1) + (j - 1)] + GAP
      let best: number
      let dir: number
      if (d >= u && d >= l) {
        best = d
        dir = 0
      } else if (u >= l) {
        best = u
        dir = 1
      } else {
        best = l
        dir = 2
      }
      s[i * (m + 1) + j] = best
      tb[i * (m + 1) + j] = dir
    }
  }
  const out: Array<[number, number]> = []
  let i = n
  let j = m
  while (i > 0 && j > 0) {
    const c = tb[i * (m + 1) + j]
    if (c === 0) {
      out.push([i - 1, j - 1])
      i--
      j--
    } else if (c === 1) i--
    else j--
  }
  return out.reverse()
}

const dist = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)

// Dominant eigenvector of the symmetric 4×4 Horn matrix by cyclic Jacobi
// rotations. Power iteration (the predictor's approach) stalls when the point
// cloud is near-planar/collinear — λ1 ≈ |λ4| and 200 rounds leave a mixed
// vector — so bench scoring gets the robust solver: real CASP targets include
// extended chains where that degeneracy bites.
function dominantEigenvector4(M: number[][]): number[] {
  const a = M.map((row) => [...row])
  // Jacobi: zero the largest off-diagonal until the matrix is diagonal enough.
  const acc = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] // rotation accumulator (row-major 4x4)
  for (let sweep = 0; sweep < 50; sweep++) {
    // largest |off-diagonal|
    let p = 0
    let q = 1
    let big = 0
    for (let i = 0; i < 4; i++)
      for (let j = i + 1; j < 4; j++)
        if (Math.abs(a[i][j]) > big) {
          big = Math.abs(a[i][j])
          p = i
          q = j
        }
    if (big < 1e-12) break
    const app = a[p][p]
    const aqq = a[q][q]
    const apq = a[p][q]
    const theta = (aqq - app) / (2 * apq)
    const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
    const c = 1 / Math.sqrt(t * t + 1)
    const sn = t * c
    // rotate rows/cols p,q of a
    for (let k = 0; k < 4; k++) {
      const akp = a[k][p]
      const akq = a[k][q]
      a[k][p] = c * akp - sn * akq
      a[k][q] = sn * akp + c * akq
    }
    for (let k = 0; k < 4; k++) {
      const apk = a[p][k]
      const aqk = a[q][k]
      a[p][k] = c * apk - sn * aqk
      a[q][k] = sn * apk + c * aqk
    }
    // accumulate the rotation into acc (columns p,q)
    for (let k = 0; k < 4; k++) {
      const rkp = acc[k * 4 + p]
      const rkq = acc[k * 4 + q]
      acc[k * 4 + p] = c * rkp - sn * rkq
      acc[k * 4 + q] = sn * rkp + c * rkq
    }
  }
  // column i of acc is the eigenvector for a[i][i]
  let best = 0
  for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i
  const ev = [acc[best], acc[4 + best], acc[8 + best], acc[12 + best]]
  const n2 = Math.hypot(...ev)
  return ev.map((x) => x / (n2 || 1))
}

// Optimal superposition of Q onto P via Horn's quaternion method (dominant
// eigenvector of the 4×4 Horn matrix). Returns CA-RMSD of the superposed clouds.
function hornRmsd(P: Array<{ x: number; y: number; z: number }>, Q: Array<{ x: number; y: number; z: number }>): number {
  const n = P.length
  const centroid = (pts: Array<{ x: number; y: number; z: number }>) =>
    [0, 1, 2].map((k) => pts.reduce((sum, p) => sum + (k === 0 ? p.x : k === 1 ? p.y : p.z), 0) / n)
  const pc = centroid(P)
  const qc = centroid(Q)
  const s = new Array<number>(9).fill(0)
  for (let i = 0; i < n; i++) {
    const qa = [Q[i].x - qc[0], Q[i].y - qc[1], Q[i].z - qc[2]]
    const pb = [P[i].x - pc[0], P[i].y - pc[1], P[i].z - pc[2]]
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) s[a * 3 + b] += qa[a] * pb[b]
  }
  const [s1, s2, s3, s4, s5, s6, s7, s8, s9] = s
  const M = [
    [s1 + s5 + s9, s6 - s8, s7 - s3, s2 - s4],
    [s6 - s8, s1 - s5 - s9, s2 + s4, s3 + s7],
    [s7 - s3, s2 + s4, -s1 + s5 - s9, s6 + s8],
    [s2 - s4, s3 + s7, s6 + s8, -s1 - s5 + s9],
  ]
  const [w, x, y, z] = dominantEigenvector4(M)
  const R = [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ]
  let sum = 0
  for (let i = 0; i < n; i++) {
    const qa = [Q[i].x - qc[0], Q[i].y - qc[1], Q[i].z - qc[2]]
    const dx = P[i].x - pc[0] - (R[0][0] * qa[0] + R[0][1] * qa[1] + R[0][2] * qa[2])
    const dy = P[i].y - pc[1] - (R[1][0] * qa[0] + R[1][1] * qa[1] + R[1][2] * qa[2])
    const dz = P[i].z - pc[2] - (R[2][0] * qa[0] + R[2][1] * qa[1] + R[2][2] * qa[2])
    sum += dx * dx + dy * dy + dz * dz
  }
  return Math.sqrt(sum / n)
}

const THRESHOLDS = [0.5, 1, 2, 4]
const INCLUSION_RADIUS = 15

export type ScoreResult = {
  /** Cα-lDDT over the shared residues (0-1). */
  lddt: number
  /** Cα-RMSD (Å) after optimal superposition of the shared residues. */
  rmsd: number
  /** Number of aligned residue pairs. */
  nAligned: number
  /** Sequence identity over the aligned range (0-1). */
  identity: number
  /** Per-residue {plddt, lddt} for the calibration curve (aligned order). */
  perResidue: Array<{ plddt: number; lddt: number }>
}

export function scoreStructures(model: ScoreRes[], ref: ScoreRes[]): ScoreResult | undefined {
  const pairs = nwPairs(
    model.map((r) => r.aa).join(''),
    ref.map((r) => r.aa).join(''),
  )
  if (pairs.length < 5) return undefined
  const mi = pairs.map(([i]) => i)
  const ri = pairs.map(([, j]) => j)
  const k = pairs.length
  // Reference distance pairs within the inclusion radius, over shared residues only.
  const pairList: Array<[number, number, number]> = []
  for (let u = 0; u < k; u++) {
    for (let v = u + 1; v < k; v++) {
      const d = dist(ref[ri[u]], ref[ri[v]])
      if (d <= INCLUSION_RADIUS) pairList.push([u, v, d])
    }
  }
  if (pairList.length === 0) return undefined
  // Per-residue preserved-pair counts across all four thresholds at once.
  const preserved = new Array<number>(k).fill(0)
  const perCount = new Array<number>(k).fill(0)
  for (const [u, v, dRef] of pairList) {
    const delta = Math.abs(dist(model[mi[u]], model[mi[v]]) - dRef)
    for (let t = 0; t < THRESHOLDS.length; t++) {
      if (delta <= THRESHOLDS[t]) {
        preserved[u]++
        preserved[v]++
      }
    }
    perCount[u]++
    perCount[v]++
  }
  // Global lDDT = mean of the four preserved fractions (CASP/CAMEO definition).
  let lddt = 0
  for (let t = 0; t < THRESHOLDS.length; t++) {
    let ok = 0
    for (const [u, v, dRef] of pairList) if (Math.abs(dist(model[mi[u]], model[mi[v]]) - dRef) <= THRESHOLDS[t]) ok++
    lddt += ok / pairList.length
  }
  lddt /= THRESHOLDS.length
  for (let u = 0; u < k; u++) if (perCount[u] > 0) preserved[u] /= perCount[u] * THRESHOLDS.length
  let ident = 0
  for (const [i, j] of pairs) if (model[i].aa === ref[j].aa) ident++
  return {
    lddt,
    rmsd: hornRmsd(
      mi.map((i) => model[i]),
      ri.map((j) => ref[j]),
    ),
    nAligned: k,
    identity: ident / k,
    perResidue: preserved
      .map((l, u) => ({ plddt: model[mi[u]].b ?? 0, lddt: l }))
      .filter((_, u) => perCount[u] > 0),
  }
}
