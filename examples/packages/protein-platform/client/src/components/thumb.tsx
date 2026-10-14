import { useEffect, useState } from 'react'

// Mini Cα-trace thumbnail for wall cards, rendered from the archive's parsed
// structure (api/archive/<id>/structure → protein.structure shape). A flat 2D
// PCA projection — the same trick the 3D panel's first frame uses to face the
// largest spread — drawn as SVG paths grouped by pLDDT band color (the pv
// AlphaFold palette). One card, one fetch, ~n segment strings; results are
// memoized per task for the session.

const bandColor = (p: number) => (p > 90 ? '#0053D6' : p >= 70 ? '#65CBF3' : p >= 50 ? '#FFDB13' : '#FF7D45')

type Thumb = { chains: string[]; colors: string[][]; viewBox: string } | null
const cache = new Map<string, Thumb>()

// Power iteration on the 3×3 covariance, then deflation for the second axis —
// enough for a pleasing static orientation, no eigen library needed.
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
  // Deflate: remove the v1 component, take the next top axis.
  const lam = v1.reduce((s, vi, i) => s + vi * (cov[i][0] * v1[0] + cov[i][1] * v1[1] + cov[i][2] * v1[2]), 0)
  const cov2 = cov.map((row, i) => row.map((x, j) => x - lam * v1[i] * v1[j]))
  const v2 = power(cov2)
  return [v1, v2]
}

// biome-ignore lint/suspicious/noExplicitAny: input is a raw archived report payload whose schema lives server-side
function projectThumb(output: any): Thumb {
  const residues: Array<{ x: number; y: number; z: number; b: number; chain: string }> = output?.residues
  if (!Array.isArray(residues) || residues.length < 2) return null
  const pts = residues.map((r) => [r.x, r.y, r.z])
  const [v1, v2] = pca2(pts)
  const flat = pts.map((p) => [
    p[0] * v1[0] + p[1] * v1[1] + p[2] * v1[2],
    p[0] * v2[0] + p[1] * v2[1] + p[2] * v2[2],
  ])
  const xs = flat.map((p) => p[0])
  const ys = flat.map((p) => p[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const span = Math.max(maxX - minX, maxY - minY, 0.001)
  // Scale into a 100×100 viewBox with a small margin; Y flips (screen coords).
  const px = (p: number[]) => +(((p[0] - minX) / span) * 96 + 2).toFixed(1)
  const py = (p: number[]) => +(98 - ((p[1] - minY) / span) * 96).toFixed(1)
  // Per chain, per band color: one path of "M..L.." segment commands.
  const chains: string[] = []
  const colors: string[][] = []
  let start = 0
  while (start < residues.length) {
    let end = start + 1
    while (end < residues.length && residues[end].chain === residues[start].chain) end++
    const byColor = new Map<string, string[]>()
    for (let i = start; i < end - 1; i++) {
      const a = flat[i]
      const b = flat[i + 1]
      const key = bandColor(residues[i].b)
      const arr = byColor.get(key) ?? []
      arr.push(`M${px(a)} ${py(a)}L${px(b)} ${py(b)}`)
      byColor.set(key, arr)
    }
    for (const [color, d] of byColor) {
      chains.push(d.join(''))
      colors.push(color)
    }
    start = end
  }
  return { chains, colors, viewBox: '0 0 100 100' }
}

type ThumbData = { d: string[]; c: string[] }

export function StructureThumb({
  taskId,
  path,
  small,
  meta,
}: {
  taskId: string
  path?: string
  small?: boolean
  /** ArchiveMeta carrying server-precomputed thumb(s) — when present the SVG
   *  renders synchronously, no structure fetch at all. */
  meta?: { thumb?: ThumbData; thumbs?: Record<string, ThumbData> }
}) {
  // Batch archives hold one PDB per target (pdb-<basename>); `path` deep-links
  // to one of them via the server's ?path= resolution (model.pdb otherwise).
  const key = path ? `${taskId}::${path}` : taskId
  const preset = path ? meta?.thumbs?.[path.split('/').pop() ?? ''] : meta?.thumb
  const [thumb, setThumb] = useState<Thumb | undefined>(() =>
    preset ? { chains: preset.d, colors: preset.c, viewBox: '0 0 100 100' } : cache.get(key),
  )
  useEffect(() => {
    if (preset) {
      setThumb({ chains: preset.d, colors: preset.c, viewBox: '0 0 100 100' })
      return
    }
    const hit = cache.get(key)
    if (hit !== undefined) {
      setThumb(hit)
      return
    }
    let alive = true
    const base = location.href.split('#')[0]
    const q = path ? `?path=${encodeURIComponent(path)}` : ''
    fetch(new URL(`api/archive/${taskId}/structure${q}`, base.endsWith('/') ? base : `${base}/`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        const t = projectThumb((j as { output?: unknown })?.output)
        cache.set(key, t)
        if (alive) setThumb(t)
      })
      .catch(() => {
        cache.set(key, null)
        if (alive) setThumb(null)
      })
    return () => {
      alive = false
    }
  }, [key, taskId, path, preset])
  if (!thumb) return null
  return (
    <svg className={`pl-thumb${small ? ' pl-thumb-sm' : ''}`} viewBox={thumb.viewBox} aria-hidden>
      {thumb.chains.map((d, i) => (
        <path
          key={i}
          d={d}
          stroke={thumb.colors[i]}
          strokeWidth={small ? 3.6 : 2.4}
          strokeLinecap="round"
          fill="none"
        />
      ))}
    </svg>
  )
}
