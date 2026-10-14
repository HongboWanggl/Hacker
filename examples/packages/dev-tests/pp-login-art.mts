// Generates packages/web-server/src/login-art.ts — the Cα traces on the login
// page — from REAL archive files, so the first thing a visitor sees is this
// platform's own output rather than stock artwork.
//
//   node --import tsx pp-login-art.mts <dir with <id>.pdb + <id>.report.json> > out.ts
//
// The projection is the same idea as the wall thumbnails (client/src/components/
// thumb.tsx): PCA of the Cα coordinates, drop to the two widest axes, colour by
// pLDDT band (AlphaFold palette) — plus a depth cue on the third axis (nearer
// strands thicker and brighter), without which a 2D trace of a real fold reads
// as a flat scribble. Kept integer-precision here — the page renders
// these at a few hundred pixels, and the whole file ships inline in the login
// HTML with no extra request (the page must work before the user has a session).
import { readdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

const dir = process.argv[2]
if (!dir) {
  console.error('usage: pp-login-art.mts <dir>   # reads <id>.pdb + <id>.report.json')
  process.exit(2)
}

// Captions are facts about the run, typed by hand because only the operator
// knows which archive is which; the numbers below are read from the report.
const CAPTIONS: Record<string, { name: string; detail: string }> = {
  tmv84cr0xxr66: { name: 'CASP14 T1025', detail: '268 aa · Cα-lDDT 0.952 · Cα-RMSD 0.65 Å' },
  tmv8foc7xfimt: { name: '人血红蛋白 α 链 · P69905', detail: '142 aa · 与 AlphaFold DB 核心区 0.31 Å' },
  tmv6s9y21r7q8: { name: 'Boltz-2 双链复合物', detail: '2 链 370 aa · ipTM 与 PAE 已评' },
}

const bandColor = (p: number) => (p > 90 ? '#0053D6' : p >= 70 ? '#65CBF3' : p >= 50 ? '#FFDB13' : '#FF7D45')

type Residue = { x: number; y: number; z: number; b: number; chain: string }

function parseCa(pdb: string): Residue[] {
  const out: Residue[] = []
  for (const line of pdb.split('\n')) {
    if (!line.startsWith('ATOM')) continue
    if (line.slice(12, 16).trim() !== 'CA') continue
    const b = Number(line.slice(60, 66).trim())
    const x = Number(line.slice(30, 38))
    const y = Number(line.slice(38, 46))
    const z = Number(line.slice(46, 54))
    if (![b, x, y, z].every(Number.isFinite)) continue
    out.push({ x, y, z, b: b > 1.5 ? b : b * 100, chain: line.slice(21, 22).trim() || 'A' })
  }
  return out
}

function pca2(pts: number[][]): [number[], number[]] {
  const mean = [0, 0, 0]
  for (const p of pts) for (let i = 0; i < 3; i++) mean[i] += p[i] / pts.length
  const cov = Array.from({ length: 3 }, () => [0, 0, 0])
  for (const p of pts) {
    const d = [p[0] - mean[0], p[1] - mean[1], p[2] - mean[2]]
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i][j] += (d[i] * d[j]) / pts.length
  }
  const power = (m: number[][]) => {
    let v = [0.577, 0.577, 0.577]
    for (let it = 0; it < 24; it++) {
      const w = [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
      ]
      const n = Math.hypot(...w) || 1
      v = w.map((x) => x / n)
    }
    return v
  }
  const v1 = power(cov)
  const lam = v1.reduce((s, vi, i) => s + vi * (cov[i][0] * v1[0] + cov[i][1] * v1[1] + cov[i][2] * v1[2]), 0)
  const cov2 = cov.map((row, i) => row.map((x, j) => x - lam * v1[i] * v1[j]))
  return [v1, power(cov2)]
}

const DEPTH_BANDS = 5

function toPaths(residues: Residue[]) {
  const pts = residues.map((r) => [r.x, r.y, r.z])
  const [v1, v2] = pca2(pts)
  // Third axis is the cross product — v1 and v2 are already orthonormal, so
  // this is exact and saves another deflation round. It is only a depth CUE
  // (opacity/width), never a coordinate: the drawing stays an honest 2D
  // projection, it just stops looking like a flat scribble.
  const v3 = [v1[1] * v2[2] - v1[2] * v2[1], v1[2] * v2[0] - v1[0] * v2[2], v1[0] * v2[1] - v1[1] * v2[0]]
  const flat = pts.map((p) => [
    p[0] * v1[0] + p[1] * v1[1] + p[2] * v1[2],
    p[0] * v2[0] + p[1] * v2[1] + p[2] * v2[2],
  ])
  const depth = pts.map((p) => p[0] * v3[0] + p[1] * v3[1] + p[2] * v3[2])
  const dMin = Math.min(...depth)
  const dSpan = Math.max(Math.max(...depth) - dMin, 1e-6)
  const band = (i: number) => Math.min(DEPTH_BANDS - 1, Math.floor(((depth[i] - dMin) / dSpan) * DEPTH_BANDS))

  const xs = flat.map((p) => p[0])
  const ys = flat.map((p) => p[1])
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY, 0.001)
  // Integer coordinates: at this render size the difference is invisible and it
  // roughly halves the bytes that ship inside the login page.
  const px = (p: number[]) => Math.round(((p[0] - minX) / span) * 92 + 4)
  const py = (p: number[]) => Math.round(96 - ((p[1] - minY) / span) * 92)
  const paths: Array<[string, string, number]> = []
  let start = 0
  while (start < residues.length) {
    let end = start + 1
    while (end < residues.length && residues[end].chain === residues[start].chain) end++
    const byBand = new Map<string, { color: string; band: number; segs: string[] }>()
    for (let i = start; i < end - 1; i++) {
      const color = bandColor(residues[i].b)
      const b = band(i)
      const key = `${color}|${b}`
      const cell = byBand.get(key) ?? { color, band: b, segs: [] }
      cell.segs.push(`M${px(flat[i])} ${py(flat[i])}L${px(flat[i + 1])} ${py(flat[i + 1])}`)
      byBand.set(key, cell)
    }
    // Confidence bands bright-to-dim so the confident core draws on top of the
    // tails; within one band, far-to-near so a nearer strand covers a farther
    // one. The z-order carries the colour story, the width/opacity carry depth.
    const colorOrder = ['#0053D6', '#65CBF3', '#FFDB13', '#FF7D45']
    for (const color of colorOrder) {
      const cells = [...byBand.values()].filter((c) => c.color === color).sort((a, b) => a.band - b.band)
      for (const cell of cells) paths.push([cell.segs.join(''), color, cell.band])
    }
    start = end
  }
  // A square viewBox around a flattened projection leaves the figure floating in
  // empty space (the coordinates fill 92 units of the WIDER axis only), so crop
  // to the drawn extents and let the box carry the protein's own aspect ratio.
  // 3 units of slack keep the glow from clipping.
  const drawX = flat.map(px)
  const drawY = flat.map(py)
  const bx = Math.max(0, Math.min(...drawX) - 3)
  const by = Math.max(0, Math.min(...drawY) - 3)
  const bw = Math.min(100, Math.max(...drawX) + 3) - bx
  const bh = Math.min(100, Math.max(...drawY) + 3) - by
  return { paths, bounds: [bx, by, bw, bh] as [number, number, number, number] }
}

const ids = readdirSync(dir)
  .filter((f) => f.endsWith('.pdb'))
  .map((f) => basename(f, '.pdb'))
  .filter((id) => CAPTIONS[id])
  .sort((a, b) => Object.keys(CAPTIONS).indexOf(a) - Object.keys(CAPTIONS).indexOf(b))

const entries = ids.map((id) => {
  const residues = parseCa(readFileSync(join(dir, `${id}.pdb`), 'utf8'))
  const report = JSON.parse(readFileSync(join(dir, `${id}.report.json`), 'utf8')) as {
    meanPlddt?: number
    residues?: number
  }
  const { paths, bounds } = toPaths(residues)
  return { id, cap: CAPTIONS[id], mean: report.meanPlddt ?? 0, n: residues.length, paths, bounds }
})

const q = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
const body = entries
  .map(
    (e) => `  {
    id: ${q(e.id)},
    name: ${q(e.cap.name)},
    detail: ${q(e.cap.detail)},
    residues: ${e.n},
    meanPlddt: ${e.mean},
    bounds: [${e.bounds.map((v) => Math.round(v * 100) / 100).join(', ')}],
    paths: [
${e.paths.map(([d, c, b]) => `      [${q(d)}, ${q(c)}, ${b}],`).join('\n')}
    ],
  },`,
  )
  .join('\n')

console.log(`// GENERATED by dev-tests/pp-login-art.mts — do not hand-edit.
// Cα traces of this platform's own archived predictions, projected with the same
// PCA the wall thumbnails use. Regenerate after a better run lands:
//   node --import tsx examples/packages/dev-tests/pp-login-art.mts <dir> > packages/web-server/src/login-art.ts

export type LoginArt = {
  id: string
  name: string
  detail: string
  residues: number
  meanPlddt: number
  /** Crop box [x, y, w, h] around the drawn trace — the SVG viewBox. */
  bounds: [number, number, number, number]
  /** [path data, stroke color, depth band 0=far…4=near] — one path per (chain, pLDDT band, depth band). */
  paths: Array<[string, string, number]>
}

// One tuple per line keeps the diff readable when a run is re-imported; the
// formatter would explode every path string onto its own line for no gain.
// biome-ignore format: generated path data
export const LOGIN_ART: LoginArt[] = [
${body}
]
`)
