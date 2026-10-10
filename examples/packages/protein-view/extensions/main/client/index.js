// @aghes/protein-view — browser panel for protein structure prediction results.
// Renders inside the workbench tool card for `predict_structure` / `analyze_confidence`:
//   1. Confidence summary (mean pLDDT, AlphaFold band bar, low-confidence segments)
//   2. Interactive per-residue pLDDT curve (hover crosshair, click to select)
//   3. 3D backbone viewer — dependency-free canvas renderer (painter's algorithm),
//      drag to rotate (with inertia), wheel to zoom, pLDDT/rainbow coloring, depth fog.
// The 3D and curve views are hover-synced. All structure data comes from the
// `protein.structure` query service via the BFF; the module has no other I/O.
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'

// ---------------------------------------------------------------------------
// AlphaFold confidence palette
const C_VERY_HIGH = '#0053D6'
const C_CONFIDENT = '#65CBF3'
const C_LOW = '#FFDB13'
const C_VERY_LOW = '#FF7D45'
const bandColor = (p) => (p > 90 ? C_VERY_HIGH : p >= 70 ? C_CONFIDENT : p >= 50 ? C_LOW : C_VERY_LOW)
const BANDS = [
  { label: '很高 (>90)', color: C_VERY_HIGH },
  { label: '高 (70–90)', color: C_CONFIDENT },
  { label: '低 (50–70)', color: C_LOW },
  { label: '极低 (<50)', color: C_VERY_LOW },
]
const RAINBOW = [
  [0, [49, 54, 149]],
  [0.25, [32, 120, 190]],
  [0.5, [36, 170, 96]],
  [0.75, [244, 200, 0]],
  [1, [215, 60, 40]],
]
const rainbowAt = (t) => {
  for (let k = 1; k < RAINBOW.length; k++) {
    const [t1, c1] = RAINBOW[k]
    const [t0, c0] = RAINBOW[k - 1]
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0 || 1)
      return `rgb(${c0.map((v, i) => Math.round(v + (c1[i] - v) * f)).join(',')})`
    }
  }
  return 'rgb(215,60,40)'
}

// Residue label with a chain prefix when the structure has multiple chains —
// Boltz-2 complexes restart numbering at 1 per chain, so a bare number is ambiguous.
function resLabel(residues, r) {
  const multi = residues.length > 1 && residues.some((x) => x.chain && x.chain !== residues[0].chain)
  return `${multi && r.chain ? `${r.chain}:` : ''}${r.aa}${r.i}`
}

// Parse a low-confidence segment reference: bare "27-60" (single chain) or
// chain-prefixed "B:1-5" (Boltz-2 complexes). Returns {chain, a, b} or null.
function parseSeg(s) {
  const m = /^(?:([A-Za-z0-9]+):)?(\d+)-(\d+)$/.exec(String(s))
  return m ? { chain: m[1] || null, a: Number(m[2]), b: Number(m[3]) } : null
}

// Multi-chain complexes (Boltz-2): one hue per chain, assigned in first-appearance
// order so Structure3D coloring and the legend chips always agree.
const CHAIN_COLORS = ['#4e79e6', '#f28e2b', '#2ca02c', '#e15759', '#9467bd', '#17becf']

// Linear sequence strip: one band-colored tile per residue (single-letter code),
// hover/click wired to the same hover/selected state as the 3D view and curve —
// a third way to scan the sequence. Chain changes get a small gap. `colorOf`
// and `titleOf` let callers re-skin the strip (e.g. |ΔpLDDT| divergence).
function SequenceStrip({ residues, hover, onHover, selected, onSelect, colorOf, titleOf }) {
  if (!Array.isArray(residues) || !residues.length) return null
  // Dense mode for long chains: smaller tiles keep the strip to a sane height.
  const dense = residues.length > 800
  return h(
    'div',
    { className: 'pv-seqstrip' + (dense ? ' pv-seqstrip--dense' : ''), role: 'listbox', 'aria-label': '残基序列条' },
    residues.map((r, idx) =>
      h(
        'div',
        {
          key: idx,
          className:
            'pv-seq-tile' + (idx === hover ? ' pv-seq-tile--hover' : '') + (idx === selected ? ' pv-seq-tile--sel' : ''),
          style: {
            background: colorOf ? colorOf(r, idx) : bandColor(r.b),
            marginLeft: idx > 0 && r.chain && residues[idx - 1].chain !== r.chain ? 5 : undefined,
          },
          title: titleOf ? titleOf(r, idx) : `${resLabel(residues, r)} · pLDDT ${r.b.toFixed(1)}`,
          onMouseEnter: () => onHover?.(idx),
          onMouseLeave: () => onHover?.(null),
          onClick: () => onSelect?.(idx),
        },
        (r.aa ?? '')[0] ?? '',
      ),
    ),
  )
}

// Divergence scale for the compare strip: calm blue at Δ≈0 → orange-red at |Δ|≥30.
function deltaColor(d) {
  const a = Math.min(Math.abs(d) / 30, 1)
  const from = [101, 203, 243]
  const to = [255, 125, 69]
  return `rgb(${from.map((v, i) => Math.round(v + (to[i] - v) * a)).join(',')})`
}
// Structural-deviation scale for the compare strip's distance mode: teal at
// ≤0.5 Å (essentially identical) → amber ~2 Å → red at ≥5 Å. The 0.55 exponent
// bends the ramp early so sub-Å noise stays calm while real deviations pop.
function distColorRgb(d) {
  const a = Math.min(Math.max(d, 0) / 5, 1) ** 0.55
  const from = [64, 180, 160]
  const to = [235, 80, 60]
  return from.map((v, i) => Math.round(v + (to[i] - v) * a))
}
const distColor = (d) => `rgb(${distColorRgb(d).join(',')})`
const isMultiChain = (residues) => Array.isArray(residues) && residues.length > 1 && residues.some((r) => r.chain && r.chain !== residues[0].chain)

function ChainLegend({ residues, hidden, onToggle }) {
  const m = new Map()
  for (const r of residues) {
    if (!m.has(r.chain)) m.set(r.chain, { chain: r.chain, n: 0, sum: 0 })
    const e = m.get(r.chain)
    e.n++
    e.sum += r.b
  }
  const stats = [...m.values()].map((e) => ({ ...e, mean: e.sum / e.n }))
  return h(
    'div',
    { className: 'pv-chain-legend' },
    stats.map((s, k) => {
      const inner = [
        h('span', { className: 'pv-chain-dot', key: 'dot', style: { background: CHAIN_COLORS[k % CHAIN_COLORS.length] } }),
        h('span', { key: 'label' }, `链 ${s.chain} · ${s.n} aa · 均值 pLDDT ${s.mean.toFixed(1)}`),
      ]
      // Toggleable chips hide/show chains in the 3D view (main panel passes
      // onToggle; other call sites keep the plain display chips).
      return onToggle
        ? h(
            'button',
            {
              className: `pv-chain-chip${hidden?.has(s.chain) ? ' pv-chain-chip--off' : ''}`,
              key: s.chain ?? k,
              onClick: () => onToggle(s.chain),
              title: hidden?.has(s.chain) ? '点击显示该链' : '点击隐藏该链',
            },
            inner,
          )
        : h('span', { className: 'pv-chain-chip', key: s.chain ?? k }, inner)
    }),
  )
}

// Legend for the interface-error 3D coloring: viridis scale over mean
// inter-chain PAE, mirroring the heatmap legend's semantics.
function InterfaceLegend() {
  return h(
    'div',
    { className: 'pv-chain-legend' },
    h(
      'span',
      { className: 'pv-chain-chip', title: '每个残基按其对其它链的平均 PAE 着色（0–32 Å）' },
      h('span', null, '0 Å'),
      h('span', { className: 'pv-pae-legendbar', style: { width: '80px' } }),
      h('span', null, '32 Å'),
      h('span', { className: 'pv-legend-note' }, '紫=界面可信，黄=界面误差大'),
    ),
  )
}

// Element key for the ligand pose: same palette the 3D view paints with.
function LigandLegend() {
  return h(
    'div',
    { className: 'pv-ligand-legend' },
    ['C', 'N', 'O', 'S', 'P'].map((el) =>
      h(
        'span',
        { key: el, className: 'pv-ligand-el', title: `配体 ${el} 原子按元素着色` },
        h('i', { style: { background: `rgb(${ligandColor(el).join(',')})` } }),
        el,
      ),
    ),
    h('span', { className: 'pv-legend-note' }, '配体按元素着色 · 悬停读出原子'),
  )
}

const verdictTone = (mean) =>
  mean >= 90 ? 'high' : mean >= 70 ? 'ok' : mean >= 50 ? 'caution' : 'warn'
const VERDICT_ZH = {
  high: '高置信结构',
  ok: '骨架可靠 · 局部待验证',
  caution: '置信偏低 · 谨慎解读',
  warn: '低置信 · 大概率含无序区',
}
const COMPLEX_VERDICT_ZH = {
  high: '预测高置信结合',
  ok: '可能结合 · 需实验验证',
  caution: '界面置信偏低 · 谨慎解读',
  warn: '低置信模型',
}

function parseReport(block) {
  const raw = typeof block?.resultPreview === 'string' ? block.resultPreview : ''
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Confidence summary header: big score + verdict + band bar + legend.
// Boltz-2 complex reports carry interface confidences instead of a mean pLDDT;
// fall back to bindingConfidence → ipTM → pTM for the headline score.
function ConfidenceSummary({ report }) {
  if (!report) return null
  const complexScore =
    typeof report.bindingConfidence === 'number'
      ? [report.bindingConfidence, '结合置信度']
      : typeof report.iptm === 'number'
        ? [report.iptm, 'ipTM 界面置信']
        : typeof report.ptm === 'number'
          ? [report.ptm, 'pTM 结构置信']
          : null
  const mean = typeof report.meanPlddt === 'number' ? report.meanPlddt : complexScore?.[0]
  if (typeof mean !== 'number') return null
  const scoreLabel = typeof report.meanPlddt === 'number' ? '平均 pLDDT' : complexScore?.[1] ?? '置信度'
  const isComplex = typeof report.meanPlddt !== 'number'
  // Complex interface confidences read on a stricter scale than pLDDT.
  const tone = isComplex ? (mean >= 80 ? 'high' : mean >= 60 ? 'ok' : mean >= 40 ? 'caution' : 'warn') : verdictTone(mean)
  const bands = report.bands ?? {}
  const bandCounts = [
    bands.veryHigh_gt90?.count ?? 0,
    bands.confident_70_90?.count ?? 0,
    bands.low_50_70?.count ?? 0,
    bands.veryLow_lt50?.count ?? 0,
  ]
  const total = bandCounts.reduce((a, b) => a + b, 0) || 1
  const parts = bandCounts.map((n, i) => ({ w: n / total, color: BANDS[i].color }))
  return h(
    'div',
    { className: 'pv-summary' },
    h(
      'div',
      { className: `pv-score pv-score--${tone}` },
      h('div', { className: 'pv-score-value' }, mean.toFixed(1)),
      h('div', { className: 'pv-score-label' }, scoreLabel),
    ),
    h(
      'div',
      { className: 'pv-summary-main' },
      h(
        'div',
        { className: 'pv-verdict' },
        h('span', { className: `pv-verdict-dot pv-verdict-dot--${tone}` }),
        isComplex ? COMPLEX_VERDICT_ZH[tone] : VERDICT_ZH[tone],
        report.residues
          ? h('span', { className: 'pv-residue-count' }, ` · ${report.residues} 残基`)
          : null,
        report.chains
          ? h('span', { className: 'pv-residue-count' }, ` · ${report.chains} 链${report.hasLigand ? ' + 配体' : ''}`)
          : null,
        // Local open-source runs are tagged by the tool; surface the provenance
        // (and runtime, which explains why the panel took minutes to appear).
        report.engine === 'boltz2-local' &&
          h(
            'span',
            {
              className: 'pv-engine-badge',
              title: '本机 boltz-community 开源权重（MPS 加速）；配 API key 可改走云端 API',
            },
            `本机引擎${report.runtimeSec != null ? ` · ${report.runtimeSec >= 90 ? `${Math.round(report.runtimeSec / 60)} 分` : `${report.runtimeSec} 秒`}` : ''}`,
          ),
      ),
      !isComplex &&
        h(
          'div',
          { className: 'pv-bandbar', role: 'img', 'aria-label': 'pLDDT 置信度分布' },
          parts.map((p, i) =>
            p.w > 0
              ? h('div', { key: i, className: 'pv-bandbar-seg', style: { flexGrow: p.w, background: p.color } })
              : null,
          ),
        ),
      !isComplex &&
        h(
          'div',
          { className: 'pv-legend' },
          BANDS.map((b, i) => {
            // Legend carries the actual share of residues in each band.
            const n = bandCounts[i]
            const hasCounts = bandCounts.some((x) => x > 0)
            const pct = hasCounts ? ` · ${Math.round((n / total) * 100)}%` : ''
            return h(
              'span',
              { key: b.label, className: 'pv-legend-item', title: hasCounts ? `${n} 个残基` : undefined },
              h('span', { className: 'pv-legend-swatch', style: { background: b.color } }),
              `${b.label}${pct}`,
            )
          }),
        ),
      // Boltz-2 complex metrics (pTM/ipTM/binding), when the report carries them.
      h('div', { className: 'pv-complex-metrics' }, complexMetricChips(report)),
    ),
  )
}

// Boltz-2 interface metrics arrive as 0-100 percentages in the report.
function complexMetricChips(report) {
  const items = [
    report.ptm != null && ['pTM', report.ptm],
    report.iptm != null && ['ipTM', report.iptm],
    // Ligand-free runs report ligand_iptm as 0.0, single-protein runs
    // protein_iptm as 0.0 — those chips would be noise.
    report.hasLigand && report.ligandIptm != null && ['ligand ipTM', report.ligandIptm],
    (report.chains ?? 2) >= 2 && report.proteinIptm != null && ['protein ipTM', report.proteinIptm],
    report.bindingConfidence != null && ['结合置信度', report.bindingConfidence],
  ].filter(Boolean)
  if (!items.length) return null
  return items.map(([label, value]) =>
    h(
      'span',
      { key: label, className: 'pv-metric-chip' },
      h('span', { className: 'pv-metric-label' }, label),
      h('span', { className: 'pv-metric-value' }, String(value)),
    ),
  )
}

// ---------------------------------------------------------------------------
// ΔpLDDT profile sparkline: signed per-bin deltas around a midline.
// Positive bins (ESMFold more confident) blue, negative bins orange.
function DeltaSparkline({ series, note, onPick }) {
  if (!Array.isArray(series) || series.length < 2) return null
  const maxAbs = Math.max(...series.map((d) => Math.abs(d.delta)), 1)
  const n = series.length
  const bar = (d, i) => {
    const el = {
      key: i,
      className: `pv-delta-bar ${d.delta >= 0 ? 'pv-delta-bar--pos' : 'pv-delta-bar--neg'}`,
      style: {
        left: `${(i / n) * 100}%`,
        width: `${(100 / n) * 0.86}%`,
        height: `${Math.max((Math.abs(d.delta) / maxAbs) * 48, 4)}%`,
        ...(d.delta >= 0 ? { bottom: '50%' } : { top: '50%' }),
      },
      title: `残基 ${d.residue} 起 · Δ ${d.delta > 0 ? '+' : ''}${d.delta}${onPick ? '（点击定位）' : ''}`,
    }
    // Click-to-locate: a bin lands the nearest chip-locatable residue in the 3D overlay.
    return onPick ? h('button', { ...el, type: 'button', onClick: () => onPick(d.residue) }) : h('div', el)
  }
  return h(
    'div',
    { className: 'pv-delta' },
    h('div', { className: 'pv-section-title' }, '逐残基 pLDDT 差值轮廓'),
    h('div', { className: 'pv-delta-bars', role: 'img', 'aria-label': 'ΔpLDDT profile' }, series.map(bar)),
    h(
      'div',
      { className: 'pv-legend' },
      h('span', { className: 'pv-legend-item' }, h('span', { className: 'pv-legend-swatch', style: { background: C_CONFIDENT } }), 'ESMFold 更自信'),
      h('span', { className: 'pv-legend-item' }, h('span', { className: 'pv-legend-swatch', style: { background: '#ff7d45' } }), 'AlphaFold 更自信'),
      note ? h('span', { className: 'pv-legend-item' }, note) : null,
    ),
  )
}

// ---------------------------------------------------------------------------
// 3D overlay for the comparison card: prediction (pLDDT colors) + the AlphaFold
// reference as a gray ghost, pre-superposed by the tool's quaternion transform.
function Compare3D({ report, services, selectedRes, onPickRes }) {
  const predPath = report.prediction?.path
  const ghostPath = report.alphafold?.savedTo
  const pw = report.pairwise?.labels
  const [pred, setPred] = useState(null)
  const [ghost, setGhost] = useState(null)
  const [hover, setHover] = useState(null)
  const selIdx = useMemo(
    () => (selectedRes == null || !pred ? null : pred.residues.findIndex((r) => r.i === selectedRes)),
    [selectedRes, pred],
  )

  useEffect(() => {
    if (!services || !predPath) return
    let alive = true
    services.call('protein.structure', { path: predPath }).then((s) => {
      if (alive && s?.residues?.length) setPred(s)
    }).catch(() => {})
    if (ghostPath) {
      services.call('protein.structure', { path: ghostPath }).then((s) => {
        if (alive && s?.residues?.length) setGhost(s)
      }).catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [services, predPath, ghostPath])

  const sup = report.compared?.superposition
  const ghostResidues = useMemo(() => {
    if (!ghost?.residues?.length || !sup) return null
    const [w, x, y, z] = sup.q
    const R = [
      [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
      [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
      [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ]
    return ghost.residues.map((r) => {
      const dx = r.x - sup.qc[0]
      const dy = r.y - sup.qc[1]
      const dz = r.z - sup.qc[2]
      return {
        i: r.i,
        aa: r.aa,
        x: R[0][0] * dx + R[0][1] * dy + R[0][2] * dz + sup.pc[0],
        y: R[1][0] * dx + R[1][1] * dy + R[1][2] * dz + sup.pc[1],
        z: R[2][0] * dx + R[2][1] * dy + R[2][2] * dz + sup.pc[2],
        b: r.b,
      }
    })
  }, [ghost, sup])

  // residue number → reference pLDDT, for the divergence strip coloring
  const gmap = useMemo(() => new Map((ghostResidues ?? []).map((g) => [g.i, g.b])), [ghostResidues])

  // Strip mode: confidence divergence (|ΔpLDDT|) or structural deviation
  // (Cα distance after superposition, matched chain+residue number).
  const [stripMode, setStripMode] = useState('plddt')
  const distMap = useMemo(() => {
    if (!ghostResidues?.length || !pred?.residues?.length) return null
    const gm = new Map(ghostResidues.map((g) => [`${g.chain ?? 'A'}:${g.i}`, g]))
    const m = new Map()
    for (const r of pred.residues) {
      const g = gm.get(`${r.chain ?? 'A'}:${r.i}`)
      if (!g) continue
      const d = Math.hypot(r.x - g.x, r.y - g.y, r.z - g.z)
      if (Number.isFinite(d)) m.set(r.i, d)
    }
    return m
  }, [ghostResidues, pred])

  if (!pred) {
    return h(
      'div',
      { className: 'pv-loading' },
      h('div', { className: 'pv-loading-inner' }, h('div', { className: 'pv-spinner' }), '加载结构…'),
    )
  }
  // Hover readout: both models' pLDDT at the pointed residue, matched by number.
  // A chip-selected residue (selIdx) is the fallback subject when not hovering.
  const activeIdx = hover != null && pred.residues[hover] ? hover : selIdx != null && selIdx >= 0 ? selIdx : null
  let hoverLine = ''
  if (activeIdx != null && pred.residues[activeIdx]) {
    const r = pred.residues[activeIdx]
    const g = ghostResidues?.find((x) => x.i === r.i)
    const sel = selIdx != null && selIdx >= 0 && hover == null
    hoverLine = `${sel ? '已选 ' : ''}${resLabel(pred.residues, r)} · ${pw ? pw[0] : '预测'} pLDDT ${r.b.toFixed(1)}`
    if (g) hoverLine += ` · ${pw ? pw[1] : '参考'} ${g.b.toFixed(1)} · Δ ${(r.b - g.b).toFixed(1)}`
    const dist = distMap?.get(r.i)
    if (dist != null) hoverLine += ` · Cα 偏差 ${dist.toFixed(2)} Å`
  }
  return h(
    'div',
    { className: 'pv-compare-wrap' },
    h(
      'div',
      { className: 'pv-grid' },
      h(
        'div',
        { className: 'pv-3d-col' },
        h(
          'div',
          { className: 'pv-3d-toolbar' },
          h(
            'div',
            { className: 'pv-section-title' },
            `3D 叠合 · ${pw ? pw[0] : '预测'} ${pred.n} aa${ghostResidues ? ` + ${pw ? pw[1] : '参考'} ${ghostResidues.length} aa` : ''}`,
          ),
          // Export composites the 3D overlay with the current strip mode below —
          // one figure carries the superposition and the divergence heat map.
          h(
            'button',
            {
              className: 'pv-export',
              onClick: (e) =>
                exportComparePng(
                  e,
                  `${(predPath ?? 'compare').split('/').pop().replace(/\.pdb$/i, '')}.${stripMode === 'dist' ? 'cadist' : 'plddt'}.png`,
                  pred.residues,
                  stripMode,
                  distMap,
                  gmap,
                ),
            },
            '导出 PNG',
          ),
          h(
            'button',
            {
              className: 'pv-export',
              onClick: (e) =>
                exportCompareCsv(
                  e,
                  `${(predPath ?? 'compare').split('/').pop().replace(/\.pdb$/i, '')}.compare.csv`,
                  pred.residues,
                  distMap,
                  gmap,
                ),
            },
            '导出 CSV',
          ),
        ),
      h(Structure3D, {
        residues: pred.residues,
        colorMode: isMultiChain(pred.residues) ? 'chain' : 'plddt',
        autoSpin: true,
        ghost: ghostResidues,
        // In the distance lens the ghost recolors by post-superposition Cα
        // deviation — structural hot spots become visible spatially, not just
        // in the strip. Ghost residues without a match stay gray.
        ghostColorOf:
          stripMode === 'dist' && distMap
            ? (a, b) => {
                const g = ghostResidues[a] ?? ghostResidues[b]
                const d = g != null ? distMap.get(g.i) : undefined
                return d != null ? distColorRgb(d) : null
              }
            : undefined,
        hover,
        onHover: setHover,
        onSelect: (k) => {
          const r = pred.residues[k]
          if (r) onPickRes?.(r.i)
        },
        selected: selIdx != null && selIdx >= 0 ? selIdx : undefined,
        hintText: `拖拽旋转 · 滚轮缩放 · 双击复位 · ${stripMode === 'dist' ? '参考链按 Cα 偏差着色，灰=无匹配' : `灰色为 ${pw ? pw[1] : 'AlphaFold 参考模型'}`}`,
      }),
      isMultiChain(pred.residues) ? h(ChainLegend, { residues: pred.residues }) : null,
      h('div', { className: 'pv-hoverline' }, hoverLine),
      ),
    ),
    // Divergence strip with two lenses over the same alignment: confidence
    // divergence (|ΔpLDDT|) or structural deviation (Cα distance after
    // superposition) — hot spots read as a horizontal heat map aligned with
    // the sequence. The toggle keeps vertical space at one strip.
    ghostResidues
      ? h(
          'div',
          { className: 'pv-stripwrap' },
          h(
            'div',
            { className: 'pv-stripmodes' },
            h(
              'button',
              {
                className: `pv-chip${stripMode === 'plddt' ? ' pv-chip--active' : ''}`,
                onClick: () => setStripMode('plddt'),
                title: '按置信度差异（|ΔpLDDT|）着色',
              },
              '置信度差异',
            ),
            distMap && distMap.size
              ? h(
                  'button',
                  {
                    className: `pv-chip${stripMode === 'dist' ? ' pv-chip--active' : ''}`,
                    onClick: () => setStripMode('dist'),
                    title: '按叠合后 Cα 偏差（Å）着色——结构差异热点',
                  },
                  'Cα 偏差',
                )
              : null,
          ),
          h(SequenceStrip, {
            residues: pred.residues,
            hover,
            onHover: setHover,
            selected: selIdx != null && selIdx >= 0 ? selIdx : undefined,
            onSelect: (idx) => {
              const r = pred.residues[idx]
              if (r) onPickRes?.(r.i)
            },
            colorOf:
              stripMode === 'dist'
                ? (r) => (distMap.has(r.i) ? distColor(distMap.get(r.i)) : '#b6b6b6')
                : (r) => (gmap.has(r.i) ? deltaColor(r.b - gmap.get(r.i)) : '#b6b6b6'),
            titleOf: (r) => {
              const g = gmap.get(r.i)
              const dist = distMap?.get(r.i)
              const ds = dist != null ? ` · Cα ${dist.toFixed(2)} Å` : ''
              const dd =
                g != null ? ` · ${pw ? pw[1] : '参考'} ${g.toFixed(1)} · Δ ${(r.b - g).toFixed(1)}` : ' · 参考无此残基'
              return `${resLabel(pred.residues, r)} · ${pw ? pw[0] : '预测'} ${r.b.toFixed(1)}${stripMode === 'dist' ? ds : dd + ds}`
            },
          }),
          stripMode === 'dist'
            ? h(
                'div',
                { className: 'pv-divlegend' },
                h('span', null, 'Cα 偏差'),
                h('span', {
                  className: 'pv-distlegend-bar',
                  style: { background: 'linear-gradient(90deg, rgb(64,180,160), rgb(240,170,70) 45%, rgb(235,80,60))' },
                }),
                h('span', null, '0.5 · 2 · ≥5 Å'),
              )
            : h(
                'div',
                { className: 'pv-divlegend' },
                h('span', null, '|ΔpLDDT|'),
                h('span', {
                  className: 'pv-divlegend-bar',
                  style: { background: 'linear-gradient(90deg, rgb(101,203,243), rgb(255,125,69))' },
                }),
                h('span', null, '0 · 15 · ≥30'),
              ),
        )
      : null,
  )
}

// ---------------------------------------------------------------------------
// AlphaFold DB comparison card (compare_alphafold results).
function CompareCard({ report, services }) {
  const c = report.compared ?? {}
  const rmsd = typeof c.caRmsd === 'number' ? c.caRmsd : null
  const core = typeof c.caRmsdCore === 'number' ? c.caRmsdCore : null
  const delta = typeof c.meanAbsPlddtDelta === 'number' ? c.meanAbsPlddtDelta : null
  const pred = report.prediction?.meanPlddt
  const af = report.alphafold?.meanPlddt
  const maxBar = Math.max(pred ?? 0, af ?? 0, 100)
  // compare_structures reuses this card with generic structure names; the
  // AlphaFold flow keeps its ESMFold-vs-AFDB wording.
  const pw = report.pairwise?.labels
  const labelA = pw ? pw[0] : '预测 (ESMFold)'
  const labelB = pw ? pw[1] : 'AlphaFold DB'
  const [selRes, setSelRes] = useState(null)
  const tone = core != null ? (core < 2 ? 'high' : core < 4 ? 'ok' : 'caution') : rmsd != null ? (rmsd < 2 ? 'high' : rmsd < 4 ? 'ok' : 'caution') : 'warn'
  const TONE_ZH = {
    high: '两模型折叠高度一致',
    ok: '整体一致 · 局部有差异',
    caution: '差异较大 · 关注低置信区',
    warn: '对比完成',
  }
  const chips = [
    rmsd != null && ['CA-RMSD 全链', `${rmsd.toFixed(2)} Å`],
    core != null && [`CA-RMSD 核心 (pLDDT≥70, ${c.coreResidues ?? '—'} 残基)`, `${core.toFixed(2)} Å`],
    delta != null && ['平均 pLDDT 差', delta.toFixed(1)],
    c.overlappingResidues != null && ['重叠残基', String(c.overlappingResidues)],
  ].filter(Boolean)
  // Copy the card's numbers as a ready-to-paste Markdown block (reports, notes).
  const [copied, setCopied] = useState(false)
  const copySummary = () => {
    const lines = [
      `结构对比：${labelA} vs ${labelB}`,
      rmsd != null ? `- CA-RMSD 全链: ${rmsd.toFixed(2)} Å` : null,
      core != null
        ? `- CA-RMSD 核心 (pLDDT≥70${c.coreResidues ? `, ${c.coreResidues} 残基` : ''}): ${core.toFixed(2)} Å`
        : null,
      delta != null ? `- 平均 pLDDT 差: ${delta.toFixed(1)}` : null,
      c.overlappingResidues != null ? `- 重叠残基: ${c.overlappingResidues}` : null,
      c.verdict ? `- 结论: ${c.verdict}` : null,
      Array.isArray(c.largestDeltas) && c.largestDeltas.length
        ? `- pLDDT 分歧最大残基: ${c.largestDeltas.map((d) => `#${d.residue} (Δ${d.delta > 0 ? '+' : ''}${d.delta})`).join(', ')}`
        : null,
    ].filter(Boolean)
    try {
      void navigator.clipboard?.writeText(lines.join('\n'))
    } catch {
      // Clipboard unavailable — the button still confirms; the same numbers
      // stay visible in the chips above.
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }
  return h(
    'div',
    { className: 'pv-root' },
    h(
      'div',
      { className: 'pv-summary' },
      h(
        'div',
        { className: `pv-score pv-score--${tone === 'high' ? 'high' : tone === 'ok' ? 'ok' : 'caution'}` },
        h('div', { className: 'pv-score-value' }, core != null ? core.toFixed(1) : rmsd != null ? rmsd.toFixed(1) : '—'),
        h('div', { className: 'pv-score-label' }, core != null ? '核心 RMSD (Å)' : 'CA-RMSD (Å)'),
      ),
      h(
        'div',
        { className: 'pv-summary-main' },
        h(
          'div',
          { className: 'pv-verdict' },
          h('span', { className: `pv-verdict-dot pv-verdict-dot--${tone}` }),
          TONE_ZH[tone],
          h('span', { className: 'pv-residue-count' }, ` · ${pw ? pw.join(' vs ') : `${report.accession ?? ''} vs ${report.model ?? 'AlphaFold DB'}`}`),
          // Jump straight to the live AlphaFold DB entry behind the reference.
          !pw && report.accession
            ? h('a', {
                className: 'pv-search-link',
                href: `https://alphafold.ebi.ac.uk/entry/AF-${encodeURIComponent(report.accession)}-F1`,
                target: '_blank',
                rel: 'noreferrer noopener',
                title: '在 AlphaFold DB 打开参考模型',
              }, 'AlphaFold DB ↗')
            : null,
        ),
        // Mean-pLDDT side-by-side bars: prediction vs reference.
        pred != null && af != null
          ? h(
              'div',
              { className: 'pv-compare-bars' },
              h('div', { className: 'pv-compare-bar-row' },
                h('span', { className: 'pv-compare-bar-label' }, labelA),
                h('div', { className: 'pv-compare-bar' }, h('div', { style: { flexGrow: pred / maxBar, background: 'var(--pv-line)' } })),
                h('span', { className: 'pv-compare-bar-value' }, pred.toFixed(1))),
              h('div', { className: 'pv-compare-bar-row' },
                h('span', { className: 'pv-compare-bar-label' }, labelB),
                h('div', { className: 'pv-compare-bar' }, h('div', { style: { flexGrow: af / maxBar, background: C_VERY_HIGH } })),
                h('span', { className: 'pv-compare-bar-value' }, af.toFixed(1))),
            )
          : null,
      ),
    ),
    h('div', { className: 'pv-complex-metrics' },
      chips.map(([label, value]) =>
        h('span', { key: label, className: 'pv-metric-chip' },
          h('span', { className: 'pv-metric-label' }, label),
          h('span', { className: 'pv-metric-value' }, value))),
      h('button', { className: 'pv-export', onClick: copySummary, title: '复制可直接粘贴的对比结论（Markdown）' },
        copied ? '已复制 ✓' : '复制结论')),
    h(Compare3D, {
      report,
      services,
      selectedRes: selRes,
      onPickRes: (i) => setSelRes((prev) => (prev === i ? null : i)),
    }),
    h(DeltaSparkline, { series: c.deltaSeries, note: c.deltaSeriesNote, onPick: (i) => setSelRes((prev) => (prev === i ? null : i)) }),
    Array.isArray(c.largestDeltas) && c.largestDeltas.length
      ? h(
          'div',
          { className: 'pv-segments' },
          h('div', { className: 'pv-section-title' }, 'pLDDT 分歧最大的残基'),
          h(
            'div',
            { className: 'pv-chips' },
            c.largestDeltas.map((d) =>
              h(
                'button',
                {
                  key: d.residue,
                  type: 'button',
                  className: `pv-chip${selRes === d.residue ? ' pv-chip--active' : ''}`,
                  title: `残基 ${d.residue}: Δ ${d.delta}（点击在 3D 叠加中定位）`,
                  onClick: () => setSelRes((prev) => (prev === d.residue ? null : d.residue)),
                },
                h('span', { className: 'pv-chip-range' }, `#${d.residue}`),
                h('span', { className: 'pv-chip-score' }, `Δ${d.delta > 0 ? '+' : ''}${d.delta}`),
              ),
            ),
          ),
          c.coreNote ? h('div', { className: 'pv-legend' }, c.coreNote) : null,
        )
      : null,
    c.verdict ? h('div', { className: 'pv-hoverline' }, c.verdict) : null,
  )
}

// ---------------------------------------------------------------------------
// Batch prediction card: one row per accession, summary chips on top.
// Inline drill-down for a batch row: lazily loads that protein's structure via
// the protein.structure service and renders the same 3D + curve pair the single
// prediction panel uses, so a batch becomes a multi-protein workbench.
function BatchRowDetail({ job, services }) {
  const [structure, setStructure] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [hover, setHover] = useState(null)
  const [selected, setSelected] = useState(null)
  const [seqCopied, setSeqCopied] = useState(false)

  useEffect(() => {
    if (!job.savedTo || !services) return
    let alive = true
    services
      .call('protein.structure', { path: job.savedTo })
      .then((s) => {
        if (alive && s && Array.isArray(s.residues)) setStructure(s)
      })
      .catch((e) => {
        if (alive) setLoadError(String(e?.message ?? e).slice(0, 200))
      })
    return () => {
      alive = false
    }
  }, [job.savedTo, services])

  if (loadError) {
    return h('div', { className: 'pv-batch-detail pv-batch-detail--err' }, `结构加载失败：${loadError}`)
  }
  const residues = structure?.residues ?? null
  if (!residues) {
    return h(
      'div',
      { className: 'pv-batch-detail pv-batch-loading' },
      h('div', { className: 'pv-loading-inner' }, h('div', { className: 'pv-spinner' }), `加载 ${job.accession} 结构…`),
    )
  }
  return h(
    'div',
    { className: 'pv-batch-detail' },
    h(
      'div',
      { className: 'pv-grid' },
      h(
        'div',
        { className: 'pv-3d-col' },
        // Same per-column export toolbars as the single-prediction panel —
        // batch drill-downs save figures too.
        h(
          'div',
          { className: 'pv-3d-toolbar' },
          h('div', { className: 'pv-section-title' }, `${job.accession} 3D 结构`),
          h(
            'button',
            { className: 'pv-export', onClick: (e) => export3DPng(e, `${job.accession}.3d.png`, residues, isMultiChain(residues) ? 'chain' : 'plddt') },
            '导出 PNG',
          ),
          h(
            'button',
            {
              className: 'pv-export',
              onClick: () => {
                try {
                  void navigator.clipboard?.writeText(fastaOf(residues, job.accession))
                } catch {}
                setSeqCopied(true)
                setTimeout(() => setSeqCopied(false), 1600)
              },
              title: '复制 FASTA 序列',
            },
            seqCopied ? '已复制 ✓' : '复制序列',
          ),
        ),
        h(Structure3D, {
          residues,
          hover,
          onHover: setHover,
          selected,
          onSelect: (k) => {
            setSelected((prev) => (prev === k ? null : k))
            setHover(k)
          },
          colorMode: isMultiChain(residues) ? 'chain' : 'plddt',
          autoSpin: false,
        }),
        isMultiChain(residues) ? h(ChainLegend, { residues }) : null,
        h(
          'div',
          { className: 'pv-hoverline' },
          hover != null && residues[hover]
            ? `${resLabel(residues, residues[hover])} · pLDDT ${residues[hover].b.toFixed(1)}`
            : selected != null && residues[selected]
              ? `已选 ${resLabel(residues, residues[selected])} · pLDDT ${residues[selected].b.toFixed(1)}`
              : job.verdict ?? '',
        ),
      ),
      h(
        'div',
        { className: 'pv-curve-col' },
        h(
          'div',
          { className: 'pv-3d-toolbar' },
          h('div', { className: 'pv-section-title' }, 'pLDDT 置信度曲线'),
          h(
            'div',
            { className: 'pv-toolbar-controls' },
            h(
              'button',
              { className: 'pv-export', onClick: (e) => exportCurvePng(e, `${job.accession}.plddt.png`, residues) },
              '导出 PNG',
            ),
            h(
              'button',
              { className: 'pv-export', onClick: () => exportResiduesCsv(`${job.accession}.plddt.csv`, residues) },
              '导出 CSV',
            ),
          ),
        ),
        h(Curve, {
          residues,
          hover,
          onHover: setHover,
          selected,
          onSelect: (idx) => setSelected((prev) => (prev === idx ? null : idx)),
        }),
        h(SequenceStrip, {
          residues,
          hover,
          onHover: setHover,
          selected,
          onSelect: (idx) => setSelected((prev) => (prev === idx ? null : idx)),
        }),
      ),
    ),
  )
}

// uniprot_search results: structured hit table. Clicking a row copies the
// accession so the researcher can paste it into the next prompt.
function SearchCard({ report }) {
  const [copied, setCopied] = useState(null)
  // Column sort: null = UniProt relevance order; clicking a header toggles
  // asc → desc → back to relevance.
  const [sort, setSort] = useState(null)
  // Multi-select for the batch hand-off: tick rows, then copy a ready-made
  // batch_predict prompt (client can't run agent turns, but the pasted prompt
  // saves the user from retyping accessions).
  const [sel, setSel] = useState(() => new Set())
  const [batchCopied, setBatchCopied] = useState(false)
  const hits = Array.isArray(report.hits) ? report.hits : []
  const sorted = useMemo(() => {
    if (!sort) return hits
    const dir = sort.dir === 'asc' ? 1 : -1
    const key = sort.key
    return [...hits].sort((a, b) => {
      if (key === 'length') return ((a.length ?? 0) - (b.length ?? 0)) * dir
      const av = String(a[key] ?? '')
      const bv = String(b[key] ?? '')
      return av.localeCompare(bv, 'zh-Hans-CN') * dir
    })
  }, [hits, sort])
  const toggleSort = (key) =>
    setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null))
  const arrow = (key) => (sort?.key !== key ? '' : sort.dir === 'asc' ? ' ▲' : ' ▼')
  const toggleSel = (acc) =>
    setSel((s) => {
      const n = new Set(s)
      if (n.has(acc)) n.delete(acc)
      else n.add(acc)
      return n
    })
  const allSel = hits.length > 0 && hits.every((x) => !x.accession || sel.has(x.accession))
  const toggleAll = () =>
    setSel((s) => (allSel ? new Set() : new Set(hits.map((x) => x.accession).filter(Boolean))))
  const copyBatch = () => {
    const text = `用 batch_predict 一次预测这些蛋白：${[...sel].join(' ')}`
    try {
      void navigator.clipboard?.writeText(text)
    } catch {
      // Clipboard unavailable — the bar still confirms selection; user can
      // retype from the visible accessions.
    }
    setBatchCopied(true)
    setTimeout(() => setBatchCopied(false), 1800)
  }
  const copy = (acc) => {
    try {
      void navigator.clipboard?.writeText(acc)
    } catch {
      // Clipboard may be unavailable; the row still shows the accession.
    }
    setCopied(acc)
    setTimeout(() => setCopied((c) => (c === acc ? null : c)), 1500)
  }
  const headCell = (key, label, extra = '') =>
    h(
      'button',
      {
        className: 'pv-search-head-cell' + (sort?.key === key ? ' pv-search-head-cell--sorted' : '') + (extra ? ` ${extra}` : ''),
        title: '点击排序',
        onClick: () => toggleSort(key),
      },
      label + arrow(key),
    )
  return h(
    'div',
    { className: 'pv-root' },
    h(
      'div',
      { className: 'pv-score-row' },
      h('div', { className: 'pv-score-main' },
        h('div', { className: 'pv-score-label' }, 'UniProt 搜索'),
        h('div', { className: 'pv-score-num' }, `${hits.length}`),
        h('div', { className: 'pv-score-sub' }, `条结果 · ${report.query ?? ''}`),
      ),
    ),
    hits.length
      ? h(
          'div',
          { className: 'pv-search-table' },
          h(
            'div',
            { className: 'pv-search-head' },
            h(
              'button',
              {
                className: 'pv-search-check' + (allSel ? ' pv-search-check--on' : ''),
                title: allSel ? '取消全选' : '全选',
                onClick: toggleAll,
              },
              allSel ? '✓' : '',
            ),
            headCell('accession', 'Accession'),
            headCell('proteinName', '蛋白'),
            headCell('organism', '物种'),
            headCell('length', '长度', 'pv-search-len'),
          ),
          ...sorted.map((hit, k) =>
            h(
              'button',
              {
                className: 'pv-search-row' + (hit.accession && sel.has(hit.accession) ? ' pv-search-row--sel' : ''),
                key: hit.accession ?? k,
                title: `点击复制 ${hit.accession ?? ''}`,
                onClick: () => copy(hit.accession),
              },
              h(
                'span',
                {
                  className: 'pv-search-check' + (hit.accession && sel.has(hit.accession) ? ' pv-search-check--on' : ''),
                  title: sel.has(hit.accession) ? '取消选择' : '加入批量预测',
                  onClick: (e) => {
                    e.stopPropagation()
                    if (hit.accession) toggleSel(hit.accession)
                  },
                },
                hit.accession && sel.has(hit.accession) ? '✓' : '',
              ),
              h(
                'span',
                { className: 'pv-search-acccell' },
                h('span', { className: 'pv-search-acc' }, hit.accession ?? '—', copied === hit.accession ? ' ✓' : ''),
                // Direct entry link — stopPropagation so the row's copy-on-click
                // doesn't fire; researchers jump to the live UniProt entry.
                hit.accession
                  ? h(
                      'a',
                      {
                        className: 'pv-search-link',
                        href: `https://www.uniprot.org/uniprotkb/${encodeURIComponent(hit.accession)}`,
                        target: '_blank',
                        rel: 'noreferrer noopener',
                        title: '在 UniProt 网站打开',
                        onClick: (e) => e.stopPropagation(),
                      },
                      '↗',
                    )
                  : null,
              ),
              h('span', { className: 'pv-search-name' }, hit.proteinName ?? hit.id ?? '—'),
              h('span', { className: 'pv-search-org' }, hit.organism ?? '—'),
              h('span', { className: 'pv-search-len' }, hit.length != null ? `${hit.length} aa` : '—'),
            ),
          ),
        )
      : h('div', { className: 'pv-fallback' }, '没有匹配的蛋白，换个关键词再试。'),
    sel.size > 0
      ? h(
          'div',
          { className: 'pv-batchbar' },
          h('span', { className: 'pv-batchbar-count' }, `已选 ${sel.size} 个`),
          h(
            'button',
            { className: 'pv-chip pv-chip--active', onClick: copyBatch, title: '复制 batch_predict 指令到剪贴板，粘贴到对话框即可批量预测' },
            batchCopied ? '已复制 ✓ 粘贴到对话框' : '复制批量预测指令',
          ),
          h('button', { className: 'pv-batchbar-clear', onClick: () => setSel(new Set()) }, '清空'),
        )
      : null,
    h('div', { className: 'pv-search-hint' }, '点击行复制 accession，点击表头排序，勾选后一键生成批量预测指令；回复「预测 <accession>」继续，或用 batch_predict 一次预测多个。'),
  )
}

function BatchCard({ report, services }) {
  const jobs = Array.isArray(report.jobs) ? report.jobs : []
  const s = report.summary ?? {}
  const okJobs = jobs.filter((j) => j.status === 'ok')
  const mean = typeof s.meanPlddt === 'number' ? s.meanPlddt : null
  const tone = mean != null ? verdictTone(mean) : s.failed ? 'caution' : 'high'
  const [openAcc, setOpenAcc] = useState(null)
  const [sortBy, setSortBy] = useState('tool')
  // Rows always render failed jobs last; the select only reorders the successes.
  const sortedJobs =
    sortBy === 'plddt'
      ? [...okJobs].sort((a, b) => (b.meanPlddt ?? 0) - (a.meanPlddt ?? 0)).concat(jobs.filter((j) => j.status !== 'ok'))
      : sortBy === 'size'
        ? [...okJobs].sort((a, b) => (b.residues ?? 0) - (a.residues ?? 0)).concat(jobs.filter((j) => j.status !== 'ok'))
        : jobs
  return h(
    'div',
    { className: 'pv-root' },
    h(
      'div',
      { className: 'pv-summary' },
      h(
        'div',
        { className: `pv-score pv-score--${tone}` },
        h('div', { className: 'pv-score-value' }, jobs.length),
        h('div', { className: 'pv-score-label' }, '批处理蛋白'),
      ),
      h(
        'div',
        { className: 'pv-summary-main' },
        h(
          'div',
          { className: 'pv-verdict' },
          h('span', { className: `pv-verdict-dot pv-verdict-dot--${tone}` }),
          `${s.ok ?? okJobs.length} 成功${s.failed ? ` · ${s.failed} 失败` : ''}`,
        ),
        h(
          'div',
          { className: 'pv-complex-metrics' },
          mean != null
            ? h('span', { className: 'pv-metric-chip' },
                h('span', { className: 'pv-metric-label' }, '平均 pLDDT（各蛋白均值）'),
                h('span', { className: 'pv-metric-value' }, mean.toFixed(1)))
            : null,
        ),
      ),
    ),
    h(
      'div',
      { className: 'pv-batch' },
      okJobs.length
        ? h(
            'div',
            { className: 'pv-3d-toolbar' },
            h('div', { className: 'pv-section-title' }, '点击行展开 3D 与曲线'),
            h(
              'div',
              { className: 'pv-toolbar-controls' },
              h(
                'select',
                { className: 'pv-select', value: sortBy, onChange: (e) => setSortBy(e.target.value), title: '排序方式（失败行始终在最后）' },
                h('option', { value: 'tool' }, '默认顺序'),
                h('option', { value: 'plddt' }, '按 pLDDT 降序'),
                h('option', { value: 'size' }, '按残基数'),
              ),
              h('button', { className: 'pv-export', onClick: () => exportBatchCsv(jobs) }, '导出 CSV'),
            ),
          )
        : null,
      sortedJobs.flatMap((j) =>
        j.status === 'ok'
          ? [
              h(
                'div',
                {
                  key: j.accession,
                  className: `pv-batch-row pv-batch-row--ok${openAcc === j.accession ? ' pv-batch-row--open' : ''}`,
                  onClick: () => setOpenAcc((prev) => (prev === j.accession ? null : j.accession)),
                  title: '点击展开 3D 结构与置信度曲线',
                },
                h('span', { className: 'pv-verdict-dot pv-verdict-dot--high' }),
                h('span', { className: 'pv-batch-acc' }, j.accession),
                h('span', { className: 'pv-batch-name' }, j.name ?? ''),
                h('span', { className: 'pv-batch-meta' }, `${j.residues} 残基${j.lowSegments ? ` · ${j.lowSegments} 低置信区段` : ''}`),
                h('span', { className: `pv-batch-score pv-batch-score--${verdictTone(j.meanPlddt)}` }, (j.meanPlddt ?? 0).toFixed(1)),
                h('span', { className: 'pv-batch-caret' }, openAcc === j.accession ? '▾' : '▸'),
              ),
              openAcc === j.accession && j.savedTo
                ? h(BatchRowDetail, { key: `${j.accession}-detail`, job: j, services })
                : null,
            ]
          : h(
              'div',
              { key: j.accession, className: 'pv-batch-row pv-batch-row--failed' },
              h('span', { className: 'pv-verdict-dot pv-verdict-dot--warn' }),
              h('span', { className: 'pv-batch-acc' }, j.accession),
              h('span', { className: 'pv-batch-name pv-batch-error' }, j.error ?? '失败'),
            ),
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// Low-confidence segment chips.
function SegmentChips({ segments, selected, onSelect }) {
  if (!segments?.length) return null
  return h(
    'div',
    { className: 'pv-segments' },
    h('div', { className: 'pv-section-title' }, '低置信区段（可能为无序区）'),
    h(
      'div',
      { className: 'pv-chips' },
      segments.map((s) =>
        h(
          'button',
          {
            key: s.residues,
            type: 'button',
            className: `pv-chip${selected === s.residues ? ' pv-chip--active' : ''}`,
            onClick: () => onSelect?.(selected === s.residues ? null : s.residues),
            title: `残基 ${s.residues} · 平均 pLDDT ${s.meanPlddt}`,
          },
          h('span', { className: 'pv-chip-range' }, s.residues),
          h('span', { className: 'pv-chip-score' }, s.meanPlddt),
        ),
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// Per-residue pLDDT curve. Pure canvas; hover → crosshair + tooltip, click → select.
// One-click PNG export of a rendered canvas (3D or curve) for slides/papers.
// Reads the live canvas at device resolution — no backend round-trip.
// FASTA text for copy-out: one record per chain when the model carries chain
// ids (suffix _A/_B…), a single record otherwise; 60-char lines per spec.
function fastaOf(residues, name) {
  const hasChains = residues.some((r) => r.chain)
  const byChain = new Map()
  for (const r of residues) {
    const k = hasChains ? (r.chain ?? 'A') : ''
    if (!byChain.has(k)) byChain.set(k, [])
    byChain.get(k).push((r.aa ?? 'X').slice(0, 1).toUpperCase())
  }
  return [...byChain.entries()]
    .map(([c, aas]) => {
      const seq = aas.join('')
      const lines = []
      for (let i = 0; i < seq.length; i += 60) lines.push(seq.slice(i, i + 60))
      return `>${name}${c ? `_${c}` : ''}\n${lines.join('\n')}`
    })
    .join('\n')
}
function downloadCanvas(canvas, name) {
  const a = document.createElement('a')
  a.href = canvas.toDataURL('image/png')
  a.download = name
  a.click()
}

function exportCanvasPng(e, canvasClass, name) {
  const col = e.currentTarget.closest('.pv-3d-col, .pv-curve-col')
  const canvas = col?.querySelector(`canvas.${canvasClass}`)
  if (!canvas || typeof canvas.toDataURL !== 'function') return
  try {
    downloadCanvas(canvas, name)
  } catch {}
}

// 3D PNG export composites the chain legend for multi-chain complexes, with
// the legend strip extending the 3D backdrop gradient so the figure is seamless.
function export3DPng(e, name, residues, colorMode) {
  const col = e.currentTarget.closest('.pv-3d-col')
  const canvas = col?.querySelector('canvas.pv-3d')
  if (!canvas || typeof canvas.toDataURL !== 'function') return
  try {
    if (colorMode !== 'chain' || !isMultiChain(residues)) {
      downloadCanvas(canvas, name)
      return
    }
    const s = canvas.width / (canvas.clientWidth || canvas.width) || 1
    const m = new Map()
    for (const r of residues) {
      if (!m.has(r.chain)) m.set(r.chain, { chain: r.chain, n: 0, sum: 0 })
      const en = m.get(r.chain)
      en.n++
      en.sum += r.b
    }
    const stats = [...m.values()]
    const c = document.createElement('canvas')
    const rowH = 18 * s
    c.width = canvas.width
    c.height = Math.round(canvas.height + 8 * s + stats.length * rowH)
    const g = c.getContext('2d')
    g.drawImage(canvas, 0, 0)
    // legend band continues the backdrop gradient (#0e1420 → #141c2b)
    const bg = g.createLinearGradient(0, 0, 0, c.height)
    bg.addColorStop(0, '#0e1420')
    bg.addColorStop(1, '#141c2b')
    g.fillStyle = bg
    g.fillRect(0, canvas.height, c.width, c.height - canvas.height)
    g.font = `${11 * s}px ui-sans-serif, system-ui`
    g.textBaseline = 'middle'
    stats.forEach((st, k) => {
      const y = canvas.height + 8 * s + k * rowH + rowH / 2
      g.fillStyle = CHAIN_COLORS[k % CHAIN_COLORS.length]
      g.fillRect(6 * s, y - 5 * s, 10 * s, 10 * s)
      g.fillStyle = 'rgba(255,255,255,0.9)'
      g.fillText(`链 ${st.chain} · ${st.n} aa · 均值 pLDDT ${(st.sum / st.n).toFixed(1)}`, 22 * s, y)
    })
    downloadCanvas(c, name)
  } catch {}
}

// Curve PNG export composites the sequence strip below the curve, so the saved
// figure carries the band heat map too (main panel; strip-less columns fall
// back to the plain canvas).
function exportCurvePng(e, name, residues) {
  const col = e.currentTarget.closest('.pv-curve-col')
  const canvas = col?.querySelector('canvas.pv-curve')
  if (!canvas || typeof canvas.toDataURL !== 'function') return
  try {
    const strip = residues?.length ? col.querySelector('.pv-seqstrip') : null
    if (!strip) {
      downloadCanvas(canvas, name)
      return
    }
    const s = canvas.width / (canvas.clientWidth || canvas.width) || 1
    const pitch = Math.max(8, Math.round(14 * s))
    const perRow = Math.max(1, Math.floor((canvas.width - 12 * s) / pitch))
    const rows = Math.ceil(residues.length / perRow)
    const top = 8 * s
    const c = document.createElement('canvas')
    c.width = canvas.width
    c.height = Math.round(canvas.height + top + rows * pitch)
    const g = c.getContext('2d')
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, c.width, c.height)
    g.drawImage(canvas, 0, 0)
    residues.forEach((r, idx) => {
      g.fillStyle = bandColor(r.b)
      g.fillRect((idx % perRow) * pitch + 6 * s, canvas.height + top + Math.floor(idx / perRow) * pitch, pitch - 1, pitch - 1)
    })
    downloadCanvas(c, name)
  } catch {}
}

// PAE heatmap export: title + heatmap + legend composed on white, matching
// the other panel exports (paper/group-meeting ready).
function exportPaePng(e, name, n, bytes, chainSizes, scale = 1) {
  const mod = e.currentTarget.closest('.pv-pae')
  const canvas = mod?.querySelector('canvas.pv-pae-canvas')
  if (!canvas || typeof canvas.toDataURL !== 'function') return
  try {
    const s = 2 // supersample for crisp text/legend
    const pad = 12 * s
    const titleH = 22 * s
    const legendH = 18 * s
    const noteH = 16 * s
    const stripW = 28 * s
    const stripX = pad + canvas.width + 6 * s
    const c = document.createElement('canvas')
    c.width = Math.max(stripX + stripW + pad, pad * 2 + 26 * s + 160 * s + 260 * s)
    c.height = canvas.height + pad * 2 + titleH + legendH + noteH
    const g = c.getContext('2d')
    if (!g) return
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, c.width, c.height)
    g.fillStyle = '#1f2430'
    g.font = `${13 * s}px system-ui, sans-serif`
    g.textBaseline = 'middle'
    g.fillText(`PAE 误差热图 · ${n}×${n}（0–32 Å）`, pad, pad + titleH / 2)
    g.drawImage(canvas, pad, pad + titleH)
    // mean-PAE profile strip, recomputed clean (no hover highlight)
    const rowH = canvas.height / n
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (let j = 0; j < n; j++) if (j !== i) sum += bytes[i * n + j]
      const mean = n > 1 ? sum / (n - 1) : 0
      const [r, gg, b] = viridisRgb(mean / 255)
      g.fillStyle = `rgb(${r},${gg},${b})`
      const w = Math.max(1 * s, (mean / 255) * stripW)
      g.fillRect(stripX, pad + titleH + i * rowH, w, Math.max(1, rowH - (rowH > 2 ? 1 : 0)))
    }
    if (chainSizes?.length > 1) {
      g.strokeStyle = 'rgba(120,120,130,0.8)'
      g.lineWidth = 1
      g.setLineDash([3 * s, 3 * s])
      let acc = 0
      for (let k = 0; k < chainSizes.length - 1; k++) {
        acc += chainSizes[k]
        // chain boundaries are residue-indexed; pooled rows cover `scale` each
        const y = pad + titleH + (acc / scale) * (canvas.height / n) + 0.5
        g.beginPath()
        g.moveTo(stripX, y)
        g.lineTo(stripX + stripW, y)
        g.stroke()
      }
      g.setLineDash([])
    }
    // legend row: "0 Å" [gradient bar] "32 Å" (chain sizes noted when present)
    const barW = 160 * s
    const barH = 8 * s
    const barY = pad + titleH + canvas.height + (legendH - barH) / 2
    const grad = g.createLinearGradient(pad, 0, pad + barW, 0)
    for (const [t, rgb] of [[0, '#440154'], [0.25, '#3b528b'], [0.5, '#21918c'], [0.75, '#5ec962'], [1, '#fde725']]) {
      grad.addColorStop(t, rgb)
    }
    g.fillStyle = '#6b7280'
    g.font = `${10 * s}px system-ui, sans-serif`
    g.textBaseline = 'middle'
    g.fillText('0 Å', pad, barY + barH / 2)
    const barX = pad + 26 * s
    g.fillStyle = grad
    g.fillRect(barX, barY, barW, barH)
    g.fillStyle = '#6b7280'
    g.fillText('32 Å', barX + barW + 6 * s, barY + barH / 2)
    if (chainSizes?.length > 1) {
      g.fillText(`虚线为链边界（${chainSizes.join(' / ')} 残基）`, barX + barW + 48 * s, barY + barH / 2)
    }
    g.fillText('右侧条形：各残基平均误差（不含自身）——长条提示界面残基或无序区', pad, barY + barH + noteH / 2 + 2 * s)
    downloadCanvas(c, name)
  } catch {}
}

// Raw pair errors as CSV (chain-prefixed 1-based indices, long format) —
// downstream analysis in Excel/Python without re-parsing the npz. A pooled
// matrix labels each row/col with the residue range it averages.
function exportPaeCsv(name, n, bytes, residues, scale = 1) {
  try {
    const label = (c) => {
      const a = c * scale
      const b = Math.min((c + 1) * scale, residues?.length ?? a + 1) - 1
      const la = residues?.[a] ? `${residues[a].chain}:${residues[a].i}` : String(a + 1)
      if (b <= a) return la
      const lb = residues?.[b] ? `${residues[b].chain}:${residues[b].i}` : String(b + 1)
      return `${la}-${lb}`
    }
    const rows = ['residue_i,residue_j,error_a']
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        rows.push(`${label(i)},${label(j)},${((bytes[i * n + j] / 255) * 32).toFixed(3)}`)
      }
    }
    const url = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  } catch {}
}

// Single-model per-residue CSV: residue, aa, pLDDT (chain-prefixed keys on
// complexes) — the raw numbers behind the confidence curve. On complex panels
// with PAE an `interface_pae` column appends each residue's mean PAE toward
// the other chains (Å) so interface analysis doesn't need the npz.
function exportResiduesCsv(name, residues, interfaceErr) {
  try {
    const withPae = !!interfaceErr
    const rows = residues.map((r, k) =>
      [
        r.chain ? `${r.chain}:${r.i}` : r.i,
        r.aa ?? '',
        r.b != null ? r.b.toFixed(1) : '',
        ...(withPae ? [interfaceErr[k] != null ? interfaceErr[k].toFixed(2) : ''] : []),
      ].join(','),
    )
    const header = withPae ? 'residue,aa,plddt,interface_pae\n' : 'residue,aa,plddt\n'
    const url = URL.createObjectURL(new Blob([header + rows.join('\n')], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  } catch {}
}

// Compare per-residue CSV: pLDDT both sides, Δ and post-superposition Cα
// distance per residue — the raw numbers behind the divergence strip.
function exportCompareCsv(e, name, residues, distMap, gmap) {
  const row = (r) => {
    const gb = gmap?.get(r.i)
    const d = distMap?.get(r.i)
    return [
      r.chain ? `${r.chain}:${r.i}` : r.i,
      r.aa ?? '',
      r.b != null ? r.b.toFixed(1) : '',
      gb != null ? gb.toFixed(1) : '',
      gb != null ? (r.b - gb).toFixed(1) : '',
      d != null ? d.toFixed(2) : '',
    ].join(',')
  }
  try {
    const url = URL.createObjectURL(
      new Blob(['residue,aa,plddt_pred,plddt_ref,delta_plddt,ca_dist\n' + residues.map(row).join('\n')], { type: 'text/csv' }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  } catch {}
}

// Compare PNG export composites the 3D overlay with the divergence strip below,
// drawn on a backdrop band that continues the 3D gradient. `mode` picks the
// strip coloring (ΔpLDDT or Cα distance); unmatched residues stay gray.
function exportComparePng(e, name, residues, mode, distMap, gmap) {
  const col = e.currentTarget.closest('.pv-3d-col')
  const canvas = col?.querySelector('canvas.pv-3d')
  if (!canvas || typeof canvas.toDataURL !== 'function' || !residues?.length) return
  try {
    const s = canvas.width / (canvas.clientWidth || canvas.width) || 1
    const pitch = Math.max(8, Math.round(14 * s))
    const perRow = Math.max(1, Math.floor((canvas.width - 12 * s) / pitch))
    const rows = Math.ceil(residues.length / perRow)
    const labelH = Math.round(20 * s)
    const top = 8 * s
    const c = document.createElement('canvas')
    c.width = canvas.width
    c.height = Math.round(canvas.height + top + labelH + rows * pitch)
    const g = c.getContext('2d')
    g.drawImage(canvas, 0, 0)
    // band continues the 3D backdrop gradient (#0e1420 → #141c2b)
    const bg = g.createLinearGradient(0, 0, 0, c.height)
    bg.addColorStop(0, '#0e1420')
    bg.addColorStop(1, '#141c2b')
    g.fillStyle = bg
    g.fillRect(0, canvas.height, c.width, c.height - canvas.height)
    g.font = `${11 * s}px ui-sans-serif, system-ui`
    g.textBaseline = 'middle'
    g.fillStyle = 'rgba(255,255,255,0.85)'
    g.fillText(
      mode === 'dist'
        ? 'Cα 偏差（叠合后） · teal ≤0.5 Å → 红 ≥5 Å'
        : '|ΔpLDDT| 置信度差异 · 0 → ≥30',
      6 * s,
      canvas.height + top + labelH / 2,
    )
    residues.forEach((r, idx) => {
      const d = distMap?.get(r.i)
      g.fillStyle =
        mode === 'dist'
          ? d != null
            ? distColor(d)
            : '#b6b6b6'
          : gmap.has(r.i)
            ? deltaColor(r.b - gmap.get(r.i))
            : '#b6b6b6'
      g.fillRect((idx % perRow) * pitch + 6 * s, canvas.height + top + labelH + Math.floor(idx / perRow) * pitch, pitch - 1, pitch - 1)
    })
    downloadCanvas(c, name)
  } catch {}
}

// Batch table → CSV download (per-accession rows, failures included).
function exportBatchCsv(jobs) {
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const head = 'accession,name,status,residues,meanPlddt,lowSegments,savedTo,error'
  const lines = jobs.map((j) =>
    [j.accession, j.name, j.status, j.residues, j.meanPlddt, j.lowSegments, j.savedTo, j.error].map(esc).join(','),
  )
  try {
    const url = URL.createObjectURL(new Blob([head + '\n' + lines.join('\n')], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'batch_predict.csv'
    a.click()
    URL.revokeObjectURL(url)
  } catch {}
}

function Curve({ residues, hover, onHover, selected, onSelect, highlight, noTitle }) {
  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const [size, setSize] = useState({ w: 600, h: 124 })
  const tooltipRef = useRef(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: 124 })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !residues?.length) return
    const dpr = window.devicePixelRatio || 1
    const { w, h: hh } = size
    canvas.width = w * dpr
    canvas.height = hh * dpr
    const g = canvas.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, w, hh)

    const padX = 6
    const n = residues.length
    const px = (idx) => padX + (idx / Math.max(1, n - 1)) * (w - padX * 2)
    // bottom band layout: plot ends at hh-26, ribbon hh-22..hh-16, ticks below
    const plotBottom = hh - 26
    const py = (p) => plotBottom - (p / 100) * (plotBottom - 8)

    // Confidence band background
    const bandsBg = [
      [90, 100, 'rgba(0,83,214,0.06)'],
      [70, 90, 'rgba(101,203,243,0.06)'],
      [50, 70, 'rgba(255,219,19,0.08)'],
      [0, 50, 'rgba(255,125,69,0.08)'],
    ]
    for (const [lo, hi, color] of bandsBg) {
      g.fillStyle = color
      g.fillRect(padX, py(hi), w - padX * 2, py(lo) - py(hi))
    }
    // Grid lines at 50/70/90
    g.font = '9px ui-sans-serif, system-ui'
    for (const [v, color] of [
      [90, C_VERY_HIGH],
      [70, C_CONFIDENT],
      [50, C_LOW],
    ]) {
      g.strokeStyle = 'rgba(128,138,155,0.25)'
      g.setLineDash([2, 3])
      g.beginPath()
      g.moveTo(padX, py(v))
      g.lineTo(w - padX, py(v))
      g.stroke()
      g.setLineDash([])
      g.fillStyle = color
      g.fillText(String(v), w - padX - 16, py(v) - 2)
    }

    // x-axis residue ticks: sequence positions along the bottom (~6 labels)
    const tickStep = [10, 20, 50, 100, 200, 500].find((s) => n / s <= 8) ?? 1000
    g.fillStyle = 'rgba(90,90,90,0.8)'
    g.textAlign = 'center'
    for (let idx = tickStep - 1; idx < n; idx += tickStep) {
      const x = px(idx)
      if (x > w - 12 || x < 12) continue
      g.fillText(String(idx + 1), x, hh - 3)
    }
    g.textAlign = 'left'

    // Highlighted segment shading
    if (highlight) {
      const seg = parseSeg(highlight)
      if (seg) {
        const inSeg = (r) => (!seg.chain || r.chain === seg.chain) && r.i >= seg.a && r.i <= seg.b
        const i0 = residues.findIndex(inSeg)
        let i1 = -1
        for (let k = n - 1; k >= 0; k--)
          if (inSeg(residues[k])) {
            i1 = k
            break
          }
        if (i0 >= 0 && i1 >= i0) {
          g.fillStyle = 'rgba(255,125,69,0.18)'
          g.fillRect(px(i0) - 2, 2, px(i1) - px(i0) + 4, plotBottom + 2)
        }
      }
    }

    // Chain separators for multi-chain complexes: faint dashed lines at chain
    // boundaries so the curve reads as per-chain blocks.
    if (isMultiChain(residues)) {
      g.strokeStyle = 'rgba(128,138,155,0.35)'
      g.setLineDash([2, 3])
      for (let k = 1; k < n; k++) {
        if (residues[k].chain === residues[k - 1].chain) continue
        const x = (px(k - 1) + px(k)) / 2
        g.beginPath()
        g.moveTo(x, 2)
        g.lineTo(x, plotBottom)
        g.stroke()
      }
      g.setLineDash([])
    }

    // Area fill under curve
    const grad = g.createLinearGradient(0, 0, 0, hh)
    grad.addColorStop(0, 'rgba(80,130,255,0.22)')
    grad.addColorStop(1, 'rgba(80,130,255,0.02)')
    g.beginPath()
    g.moveTo(px(0), py(residues[0].b))
    for (let k = 1; k < n; k++) g.lineTo(px(k), py(residues[k].b))
    g.lineTo(px(n - 1), plotBottom)
    g.lineTo(px(0), plotBottom)
    g.closePath()
    g.fillStyle = grad
    g.fill()

    // Curve
    g.beginPath()
    g.moveTo(px(0), py(residues[0].b))
    for (let k = 1; k < n; k++) g.lineTo(px(k), py(residues[k].b))
    g.strokeStyle = '#4a7dff'
    g.lineWidth = 1.4
    g.stroke()

    // pLDDT ribbon at the bottom — same palette as the 3D view, so the curve
    // and the structure read as one picture.
    const ribbonY = hh - 20
    for (let k = 0; k < n; k++) {
      g.fillStyle = bandColor(residues[k].b)
      g.fillRect(px(k) - (w - padX * 2) / (2 * n), ribbonY, (w - padX * 2) / n + 0.5, 6)
    }

    // Hover crosshair
    if (hover != null && hover >= 0 && hover < n) {
      const x = px(hover)
      g.strokeStyle = 'rgba(20,24,32,0.45)'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(x, 4)
      g.lineTo(x, plotBottom)
      g.stroke()
      g.beginPath()
      g.arc(x, py(residues[hover].b), 3.2, 0, Math.PI * 2)
      g.fillStyle = bandColor(residues[hover].b)
      g.fill()
      g.strokeStyle = '#fff'
      g.lineWidth = 1.4
      g.stroke()
    }
    // Selected marker
    if (selected != null && selected >= 0 && selected < n) {
      const x = px(selected)
      g.beginPath()
      g.arc(x, py(residues[selected].b), 4.4, 0, Math.PI * 2)
      g.fillStyle = bandColor(residues[selected].b)
      g.fill()
      g.strokeStyle = '#141820'
      g.lineWidth = 1.6
      g.stroke()
    }
  }, [residues, size, hover, selected, highlight])

  const pick = useCallback(
    (ev) => {
      const canvas = canvasRef.current
      if (!canvas || !residues?.length) return
      const rect = canvas.getBoundingClientRect()
      const x = ev.clientX - rect.left
      const n = residues.length
      const idx = Math.round(((x - 6) / Math.max(1, rect.width - 12)) * (n - 1))
      return Math.max(0, Math.min(n - 1, idx))
    },
    [residues],
  )

  if (!residues?.length) return null
  const n = residues.length
  const hovered = hover != null ? residues[hover] : null
  return h(
    'div',
    { className: 'pv-curve-wrap', ref: wrapRef },
    noTitle ? null : h('div', { className: 'pv-section-title' }, '逐残基 pLDDT'),
    h('div', { className: 'pv-curve-holder' },
      h('canvas', {
        ref: canvasRef,
        className: 'pv-curve',
        style: { width: '100%', height: size.h },
        onMouseMove: (ev) => {
          const idx = pick(ev)
          if (idx != null) onHover(idx)
          if (tooltipRef.current && ev.nativeEvent) {
            const r = ev.currentTarget.getBoundingClientRect()
            tooltipRef.current.style.left = `${Math.min(Math.max(ev.clientX - r.left, 56), r.width - 56)}px`
          }
        },
        onMouseLeave: () => onHover(null),
        onClick: (ev) => {
          const idx = pick(ev)
          if (idx != null) onSelect?.(idx)
        },
      }),
      h(
        'div',
        { className: `pv-curve-tip${hovered ? ' pv-curve-tip--on' : ''}`, ref: tooltipRef },
        hovered
          ? `${hovered.aa}${hovered.i} · ${hovered.b.toFixed(1)}`
          : `${n} 残基 · 点击选中`,
      ),
    ),
  )
}

// ---------------------------------------------------------------------------
// 3D backbone viewer. Canvas 2D, painter's algorithm, orthographic + depth fog.
// `ghostColorOf(aIdx, bIdx)` lets the compare card recolor ghost segments
// (e.g. by post-superposition Cα distance); null falls back to the gray ghost.
// Element colors for ligand ball rendering (RGB triples, muted for the dark
// backdrop; unknown elements fall back to gray).
const EL_COLORS = { C: [138, 147, 158], N: [88, 132, 220], O: [214, 98, 98], S: [219, 187, 70], P: [226, 148, 70], F: [140, 200, 170], CL: [140, 200, 150], BR: [160, 110, 80] }
const ligandColor = (el) => EL_COLORS[el] ?? [154, 165, 181]

function Structure3D({ residues, hover, onHover, selected, onSelect, colorMode, autoSpin, interfaceErr, ligand, showLigand = true, ghost, ghostColorOf, hintText, hiddenChains }) {
  // Chain visibility toggle: hidden residues keep their indices (curve/strip
  // cross-linking stays aligned) but are skipped in drawing and hit-testing.
  const isHidden = useCallback((k) => !!(hiddenChains?.size && hiddenChains.has(residues?.[k]?.chain)), [hiddenChains, residues])
  const canvasRef = useRef(null)
  const tipRef = useRef(null)
  const wrapRef = useRef(null)
  const [size, setSize] = useState({ w: 600, h: 340 })
  const view = useRef({ yaw: -0.6, pitch: 0.35, zoom: 1, dragging: false, lastX: 0, lastY: 0, vx: 0, vy: 0, lastInteract: 0 })
  const frame = useRef(0)
  const wake = useRef(0)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: 340 }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Geometry memo: centered coordinates + bonds.
  const geo = useMemo(() => {
    if (!residues?.length) return null
    const pts = residues.map((r) => [r.x, r.y, r.z])
    const c = [0, 1, 2].map((d) => pts.reduce((s, p) => s + p[d], 0) / pts.length)
    let maxR = 0
    const centered = pts.map((p) => {
      const v = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]
      maxR = Math.max(maxR, Math.hypot(...v))
      return v
    })
    // Chain index by first appearance — used by 'chain' color mode.
    const chainOrder = new Map()
    const chainIdx = residues.map((r) => {
      if (!chainOrder.has(r.chain)) chainOrder.set(r.chain, chainOrder.size)
      return chainOrder.get(r.chain) ?? 0
    })
    const bonds = []
    for (let k = 1; k < pts.length; k++) {
      // Never bond across a chain break (Boltz-2 complexes): interface residues
      // of different chains can sit within the 4.5 Å CA-CA gate.
      if (residues[k].chain && residues[k - 1].chain && residues[k].chain !== residues[k - 1].chain) continue
      const d = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1], pts[k][2] - pts[k - 1][2])
      if (d < 4.5) bonds.push([k - 1, k])
    }
    // Ghost chain (e.g. AlphaFold reference superposed by the tool): centered on
    // the SAME centroid so it lands where the tool's transform put it.
    let ghostCentered = null
    let ghostBonds = null
    if (ghost?.length) {
      ghostCentered = ghost.map((r) => [r.x - c[0], r.y - c[1], r.z - c[2]])
      ghostBonds = []
      for (let k = 1; k < ghost.length; k++) {
        const d = Math.hypot(ghost[k].x - ghost[k - 1].x, ghost[k].y - ghost[k - 1].y, ghost[k].z - ghost[k - 1].z)
        if (d < 4.5) ghostBonds.push([k - 1, k])
      }
      for (const v of ghostCentered) maxR = Math.max(maxR, Math.hypot(...v))
    }
    // Ligand (HETATM atoms from the service): same centroid/scale as the protein.
    let ligandCentered = null
    let ligandContacts = null
    if (ligand?.atoms?.length) {
      ligandCentered = ligand.atoms.map((a) => [a.x - c[0], a.y - c[1], a.z - c[2]])
      for (const v of ligandCentered) maxR = Math.max(maxR, Math.hypot(...v))
      // Pocket contacts: residues whose Cα sits within 5 Å of any ligand atom
      // (deduped to the closest atom per residue). Drawn as faint dashed lines
      // so the binding pocket reads without hovering.
      const best = new Map()
      ligandCentered.forEach((la, li) => {
        pts.forEach((p, k) => {
          const d = Math.hypot(la[0] - p[0], la[1] - p[1], la[2] - p[2])
          if (d < 5 && (!best.has(k) || d < best.get(k)[2])) best.set(k, [li, k, d])
        })
      })
      ligandContacts = [...best.values()].map(([li, k]) => [li, k])
    }
    return { centered, bonds, radius: maxR || 1, ghostCentered, ghostBonds, ligandCentered, ligandContacts, chainIdx }
  }, [residues, ghost, ligand])
  // NOTE: `ligand` here is the normalized { n, atoms, bonds } the parent builds
  // from the service's flat ligandAtoms/ligandBonds arrays.

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !geo) return
    const ctx2d = canvas.getContext('2d')
    const dpr = window.devicePixelRatio || 1

    const draw = () => {
      const { w, h: hh } = size
      canvas.width = w * dpr
      canvas.height = hh * dpr
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
      // Backdrop
      const bg = ctx2d.createLinearGradient(0, 0, 0, hh)
      bg.addColorStop(0, '#0e1420')
      bg.addColorStop(1, '#141c2b')
      ctx2d.fillStyle = bg
      ctx2d.fillRect(0, 0, w, hh)

      const v = view.current
      const now = performance.now()
      if (autoSpin && !v.dragging && now - v.lastInteract > 2500) {
        v.yaw += 0.0035
      }
      // Inertia
      if (!v.dragging && (Math.abs(v.vx) > 1e-4 || Math.abs(v.vy) > 1e-4)) {
        v.yaw += v.vx
        v.pitch = Math.max(-1.4, Math.min(1.4, v.pitch + v.vy))
        v.vx *= 0.92
        v.vy *= 0.92
      }
      const cy = Math.cos(v.yaw), sy = Math.sin(v.yaw)
      const cp = Math.cos(v.pitch), sp = Math.sin(v.pitch)
      const scale = (Math.min(w, hh) * 0.42 * v.zoom) / geo.radius
      const cx0 = w / 2, cy0 = hh / 2

      const projected = geo.centered.map(([x, y, z]) => {
        const x1 = x * cy + z * sy
        const z1 = -x * sy + z * cy
        const y1 = y * cp - z1 * sp
        const z2 = y * sp + z1 * cp
        return { x: cx0 + x1 * scale, y: cy0 + y1 * scale, z: z2 }
      })
      const ghostProjected = geo.ghostCentered?.map(([x, y, z]) => {
        const x1 = x * cy + z * sy
        const z1 = -x * sy + z * cy
        const y1 = y * cp - z1 * sp
        const z2 = y * sp + z1 * cp
        return { x: cx0 + x1 * scale, y: cy0 + y1 * scale, z: z2 }
      })
      const ligProjected = showLigand ? geo.ligandCentered?.map(([x, y, z]) => {
        const x1 = x * cy + z * sy
        const z1 = -x * sy + z * cy
        const y1 = y * cp - z1 * sp
        const z2 = y * sp + z1 * cp
        return { x: cx0 + x1 * scale, y: cy0 + y1 * scale, z: z2 }
      }) : null

      const zmin = Math.min(...projected.map((p) => p.z))
      const zmax = Math.max(...projected.map((p) => p.z))
      const depth01 = (z) => (zmax - zmin < 1e-6 ? 0.5 : (z - zmin) / (zmax - zmin)) // 0=front
      const fog = (rgb, d) => {
        // Dark-backdrop fog: front slightly over-bright, back dims toward the backdrop.
        const f = 1.15 - 0.5 * d
        return `rgb(${rgb.map((c) => Math.round(Math.min(255, c * f))).join(',')})`
      }
      const hexToRgb = (hex) => {
        const n = Number.parseInt(hex.replace('#', ''), 16)
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      }
      const colorOf = (k) => {
        const r = residues[k]
        if (colorMode === 'chain') return hexToRgb(CHAIN_COLORS[(geo.chainIdx?.[k] ?? 0) % CHAIN_COLORS.length])
        if (colorMode === 'rainbow') return rainbowAt(k / Math.max(1, residues.length - 1)).match(/\d+/g).map(Number)
        // Interface mode: viridis over the residue's mean inter-chain PAE —
        // same semantics as the heatmap (purple = confident interface).
        if (colorMode === 'interface' && interfaceErr) {
          return viridisRgb(Math.min(1, (interfaceErr[k] ?? 0) / 32))
        }
        return hexToRgb(bandColor(r.b))
      }

      // Bonds back → front
      const items = geo.bonds
        .filter(([a, b]) => !isHidden(a) && !isHidden(b))
        .map(([a, b]) => ({ kind: 'bond', a, b, z: (projected[a].z + projected[b].z) / 2 }))
        .concat(projected.map((p, k) => ({ kind: 'ca', k, z: p.z })).filter((it) => !isHidden(it.k)))
      if (ghostProjected && geo.ghostBonds) {
        for (const [a, b] of geo.ghostBonds) {
          items.push({ kind: 'ghost', a, b, z: (ghostProjected[a].z + ghostProjected[b].z) / 2 })
        }
      }
      // Ligand bonds/atoms join the same depth sort so the pose reads inside
      // the pocket instead of painted over the protein.
      if (ligProjected && ligand) {
        for (const [a, b] of ligand.bonds ?? []) {
          if (a >= ligProjected.length || b >= ligProjected.length) continue
          items.push({ kind: 'ligb', a, b, z: (ligProjected[a].z + ligProjected[b].z) / 2 })
        }
        ligProjected.forEach((p, k) => items.push({ kind: 'liga', k, z: p.z }))
      }
      // Pocket contact lines: faint dashed ties from ligand atoms to nearby
      // Cαs, drawn beneath the atoms so the binding pocket reads at a glance
      // without cluttering the pose itself.
      if (ligProjected && geo.ligandContacts?.length) {
        ctx2d.setLineDash([3, 3])
        ctx2d.lineWidth = 0.8
        for (const [li, k] of geo.ligandContacts) {
          if (isHidden(k)) continue
          const p1 = ligProjected[li]
          const p2 = projected[k]
          const d = depth01((p1.z + p2.z) / 2)
          ctx2d.strokeStyle = `rgba(255,255,255,${0.3 * (1 - 0.5 * d)})`
          ctx2d.beginPath()
          ctx2d.moveTo(p1.x, p1.y)
          ctx2d.lineTo(p2.x, p2.y)
          ctx2d.stroke()
        }
        ctx2d.setLineDash([])
      }
      items.sort((m, n2) => m.z - n2.z)

      for (const it of items) {
        if (it.kind === 'ghost') {
          const p1 = ghostProjected[it.a]
          const p2 = ghostProjected[it.b]
          const d = depth01(it.z)
          const gc = ghostColorOf?.(it.a, it.b)
          if (gc) {
            const f = 1.15 - 0.5 * d
            ctx2d.strokeStyle = `rgba(${Math.round(Math.min(255, gc[0] * f))},${Math.round(Math.min(255, gc[1] * f))},${Math.round(Math.min(255, gc[2] * f))},${0.7 * (1 - 0.5 * d)})`
          } else ctx2d.strokeStyle = `rgba(158,168,186,${0.55 * (1 - 0.55 * d)})`
          ctx2d.lineWidth = 0.9 + 0.9 * (1 - d)
          ctx2d.lineCap = 'round'
          ctx2d.beginPath()
          ctx2d.moveTo(p1.x, p1.y)
          ctx2d.lineTo(p2.x, p2.y)
          ctx2d.stroke()
        } else if (it.kind === 'ligb') {
          const p1 = ligProjected[it.a]
          const p2 = ligProjected[it.b]
          const d = depth01(it.z)
          ctx2d.strokeStyle = `rgba(196,204,218,${0.6 * (1 - 0.4 * d)})`
          ctx2d.lineWidth = 0.8 + 0.8 * (1 - d)
          ctx2d.lineCap = 'round'
          ctx2d.beginPath()
          ctx2d.moveTo(p1.x, p1.y)
          ctx2d.lineTo(p2.x, p2.y)
          ctx2d.stroke()
        } else if (it.kind === 'liga') {
          const p = ligProjected[it.k]
          const d = depth01(it.z)
          const isHover = hover === -1 - it.k
          const col = ligandColor(ligand.atoms[it.k]?.el)
          ctx2d.fillStyle = fog(col, d)
          ctx2d.beginPath()
          ctx2d.arc(p.x, p.y, (2.2 + 1.8 * (1 - d)) * (isHover ? 1.6 : 1), 0, Math.PI * 2)
          ctx2d.fill()
          // faint rim keeps light atoms (C) readable against the backdrop
          ctx2d.strokeStyle = isHover ? '#ffffff' : `rgba(255,255,255,${0.25 * (1 - d)})`
          ctx2d.lineWidth = isHover ? 1.4 : 0.6
          ctx2d.stroke()
        } else if (it.kind === 'bond') {
          const p1 = projected[it.a]
          const p2 = projected[it.b]
          const d = depth01(it.z)
          const dimmed = selected != null && it.a !== selected && it.b !== selected
          ctx2d.strokeStyle = dimmed ? 'rgba(120,130,150,0.25)' : fog(colorOf(it.a), d)
          ctx2d.lineWidth = (0.8 + 2.4 * (1 - d)) * (dimmed ? 0.6 : 1)
          ctx2d.lineCap = 'round'
          ctx2d.beginPath()
          ctx2d.moveTo(p1.x, p1.y)
          ctx2d.lineTo(p2.x, p2.y)
          ctx2d.stroke()
        } else {
          const p = projected[it.k]
          const d = depth01(p.z)
          const isHover = hover === it.k
          const isSel = selected === it.k
          const dimmed = selected != null && !isSel
          const r = (1.7 + 1.5 * (1 - d)) * (isHover || isSel ? 1.6 : 1)
          const col = colorOf(it.k)
          ctx2d.beginPath()
          ctx2d.arc(p.x, p.y, r, 0, Math.PI * 2)
          ctx2d.fillStyle = dimmed ? fog(col.map((c) => c * 0.35 + 30), d) : fog(col, d)
          ctx2d.fill()
          if (isHover || isSel) {
            ctx2d.strokeStyle = isSel ? '#ffffff' : 'rgba(255,255,255,0.85)'
            ctx2d.lineWidth = 1.6
            ctx2d.stroke()
          }
        }
      }

      // Adaptive loop: keep scheduling frames only while something is actually
      // moving (drag, inertia decay, auto-spin). A static panel draws once and
      // sleeps; a timeout wakes it exactly when auto-spin is due to resume.
      const spinning = autoSpin && !v.dragging && now - v.lastInteract > 2500
      const inertia = !v.dragging && (Math.abs(v.vx) > 1e-4 || Math.abs(v.vy) > 1e-4)
      if (spinning || inertia || v.dragging) {
        frame.current = requestAnimationFrame(draw)
      } else if (autoSpin) {
        wake.current = setTimeout(() => {
          frame.current = requestAnimationFrame(draw)
        }, Math.max(50, 2510 - (now - v.lastInteract)))
      }
    }
    frame.current = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(frame.current)
      clearTimeout(wake.current)
    }
  }, [geo, size, residues, hover, selected, colorMode, autoSpin, interfaceErr, ligand, showLigand, ghost, ghostColorOf, isHidden])

  const pick = useCallback(
    (ev) => {
      const canvas = canvasRef.current
      if (!canvas || !geo) return null
      const rect = canvas.getBoundingClientRect()
      const v = view.current
      const cy = Math.cos(v.yaw), sy = Math.sin(v.yaw)
      const cp = Math.cos(v.pitch), sp = Math.sin(v.pitch)
      const scale = (Math.min(rect.width, rect.height) * 0.42 * v.zoom) / geo.radius
      const mx = ev.clientX - rect.left - rect.width / 2
      const my = ev.clientY - rect.top - rect.height / 2
      let best = null
      let bestD = 12 * 12
      geo.centered.forEach(([x, y, z], k) => {
        if (isHidden(k)) return
        const x1 = x * cy + z * sy
        const z1 = -x * sy + z * cy
        const y1 = y * cp - z1 * sp
        const dx = x1 * scale - mx
        const dy = y1 * scale - my
        const d = dx * dx + dy * dy
        if (d < bestD) {
          bestD = d
          best = k
        }
      })
      // Ligand atoms share the pick space, encoded as negative indices
      // (-1 - atomIndex) so residue consumers can ignore them by sign.
      if (showLigand && ligand && geo.ligandCentered) {
        geo.ligandCentered.forEach(([x, y, z], k) => {
          const x1 = x * cy + z * sy
          const z1 = -x * sy + z * cy
          const y1 = y * cp - z1 * sp
          const dx = x1 * scale - mx
          const dy = y1 * scale - my
          const d = dx * dx + dy * dy
          if (d < bestD) {
            bestD = d
            best = -1 - k
          }
        })
      }
      return best
    },
    [geo, isHidden, ligand, showLigand],
  )

  return h(
    'div',
    { className: 'pv-3d-wrap', ref: wrapRef },
    h('canvas', {
      ref: canvasRef,
      className: 'pv-3d',
      style: { width: '100%', height: size.h },
      onPointerDown: (ev) => {
        ev.currentTarget.setPointerCapture(ev.pointerId)
        const v = view.current
        v.dragging = true
        v.lastX = ev.clientX
        v.lastY = ev.clientY
        v.downX = ev.clientX
        v.downY = ev.clientY
        v.vx = 0
        v.vy = 0
        v.lastInteract = performance.now()
      },
      onPointerMove: (ev) => {
        const v = view.current
        if (v.dragging) {
          const dx = ev.clientX - v.lastX
          const dy = ev.clientY - v.lastY
          v.yaw += dx * 0.008
          v.pitch = Math.max(-1.4, Math.min(1.4, v.pitch + dy * 0.008))
          v.vx = dx * 0.004
          v.vy = dy * 0.004
          v.lastX = ev.clientX
          v.lastY = ev.clientY
          v.lastInteract = performance.now()
        } else {
          const k = pick(ev)
          if (k != null) onHover?.(k)
          else onHover?.(null)
          // Floating readout follows the cursor (like the curve tooltip); the
          // visible/off state rides on the hover prop.
          if (tipRef.current) {
            const wrap = tipRef.current.parentElement.getBoundingClientRect()
            tipRef.current.style.left = `${Math.min(ev.clientX - wrap.left + 12, wrap.width - 96)}px`
            tipRef.current.style.top = `${ev.clientY - wrap.top - 28}px`
          }
        }
      },
      onPointerUp: (ev) => {
        const v = view.current
        v.dragging = false
        v.lastInteract = performance.now()
        // A click (pointer barely moved) picks the residue under the cursor —
        // same selection model as clicking the curve.
        const moved = Math.hypot(ev.clientX - (v.downX ?? ev.clientX), ev.clientY - (v.downY ?? ev.clientY))
        if (moved < 5 && onSelect) {
          const k = pick(ev)
          // negative picks are ligand atoms — hover-only, never selectable
          if (k != null && k >= 0) onSelect(k)
        }
      },
      onPointerLeave: () => onHover?.(null),
      onWheel: (ev) => {
        ev.preventDefault()
        const v = view.current
        v.zoom = Math.max(0.4, Math.min(6, v.zoom * (ev.deltaY < 0 ? 1.12 : 0.89)))
        v.lastInteract = performance.now()
      },
      onDoubleClick: () => {
        Object.assign(view.current, { yaw: -0.6, pitch: 0.35, zoom: 1, vx: 0, vy: 0 })
      },
    }),
    (() => {
      const r = hover != null ? residues[hover] : null
      return h(
        'div',
        { className: `pv-3d-tip${r ? ' pv-3d-tip--on' : ''}`, ref: tipRef },
        r ? `${resLabel(residues, r)} · pLDDT ${r.b.toFixed(1)}` : '',
      )
    })(),
    h('div', { className: 'pv-3d-hint' }, hintText ?? '拖拽旋转 · 滚轮缩放 · 双击复位'),
  )
}

// ---------------------------------------------------------------------------
// Tool view root. Registered for both tools; degrades gracefully per data availability.
// ---------------------------------------------------------------------------
// PAE (predicted aligned error) heatmap — Boltz-2 local runs save the N×N
// error matrix next to the model; viridis colormap, chain boundaries marked,
// hovering a cell reads the pair error in Å and syncs the 3D/curve hover.

const VIRIDIS_STOPS = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
]
function viridisRgb(t) {
  const x = Math.max(0, Math.min(1, t)) * (VIRIDIS_STOPS.length - 1)
  const i = Math.min(VIRIDIS_STOPS.length - 2, Math.floor(x))
  const f = x - i
  const a = VIRIDIS_STOPS[i]
  const b = VIRIDIS_STOPS[i + 1]
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ]
}

function PaesModule({ paePath, residues, services, onHover, hover, onInterface, name = 'structure' }) {
  const [pae, setPae] = useState(null) // { n, bytes, scale }
  const [error, setError] = useState(null)
  const [hoverCell, setHoverCell] = useState(null) // { i, j } pooled-matrix indices
  const [stripRow, setStripRow] = useState(null) // row hovered in the side profile
  const [focusPair, setFocusPair] = useState(null) // 'A|B' — chip-clicked chain pair
  const canvasRef = useRef(null)
  const stripRef = useRef(null)

  useEffect(() => {
    setPae(null)
    setError(null)
    setHoverCell(null)
    setFocusPair(null)
    if (!paePath || !services) return
    let alive = true
    services
      .call('protein.pae', { path: paePath })
      .then((m) => {
        if (!alive || !m || typeof m.n !== 'number' || typeof m.data !== 'string') return
        const bin = atob(m.data)
        const bytes = new Uint8Array(bin.length)
        for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k)
        // scale > 1 means the matrix was mean-pooled (one cell = scale residues)
        setPae({ n: m.n, bytes, scale: m.scale === 1 || m.scale >= 2 ? m.scale : 1 })
      })
      .catch((e) => {
        if (alive) setError(String(e?.message ?? e).slice(0, 160))
      })
    return () => {
      alive = false
    }
  }, [paePath, services])

  // Chain segment sizes in residue order — dashed boundary lines overlay the
  // heatmap where one chain ends and the next begins.
  const chainSizes = useMemo(() => {
    if (!residues) return null
    const sizes = []
    let cur = null
    for (const r of residues) {
      if (r.chain !== cur) {
        sizes.push(0)
        cur = r.chain
      }
      sizes[sizes.length - 1] += 1
    }
    return sizes.length > 1 ? sizes : null
  }, [residues])

  const n = pae?.n ?? 0
  const scale = pae?.scale ?? 1
  const cell = n ? Math.max(1, Math.min(8, Math.floor(480 / n))) : 0
  const px = n * cell

  // Per-residue mean PAE (diagonal excluded — that's self-error, always 0).
  // Long bars flag interface residues / uncertain folds at a glance.
  const rowMeans = useMemo(() => {
    if (!pae || !n) return null
    const m = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let s = 0
      for (let j = 0; j < n; j++) if (j !== i) s += pae.bytes[i * n + j]
      m[i] = n > 1 ? s / (n - 1) : 0
    }
    return m
  }, [pae, n])

  // Mean inter-chain PAE per chain pair — the per-pair view iptm can't give:
  // a low A–B mean says the modeled interface itself is confident.
  const chainPairs = useMemo(() => {
    if (!pae || !n || !residues || !residues.length) return null
    const cellChain = []
    for (let c = 0; c < n; c++) {
      const r = residues[Math.min(c * scale, residues.length - 1)]
      cellChain.push(r ? r.chain : '?')
    }
    const acc = new Map()
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue
        const a = cellChain[i]
        const b = cellChain[j]
        if (a === b) continue
        const key = a < b ? `${a}|${b}` : `${b}|${a}`
        let e = acc.get(key)
        if (!e) acc.set(key, (e = { sum: 0, cnt: 0 }))
        e.sum += pae.bytes[i * n + j]
        e.cnt++
      }
    }
    return [...acc.entries()]
      .map(([key, e]) => {
        const [a, b] = key.split('|')
        return { a, b, meanA: (e.sum / e.cnt / 255) * 32 }
      })
      .sort((x, y) => x.meanA - y.meanA)
  }, [pae, n, residues, scale])

  // Per-residue mean PAE toward the *other* chains (Å, residue resolution —
  // pooled cells are re-expanded). Lifted to the parent so the 3D view can
  // offer interface-error coloring; null on single-chain panels.
  const interfaceErr = useMemo(() => {
    if (!pae || !n || !residues || !residues.length) return null
    const cellChain = []
    for (let c = 0; c < n; c++) {
      const r = residues[Math.min(c * scale, residues.length - 1)]
      cellChain.push(r ? r.chain : '?')
    }
    const out = new Float32Array(residues.length)
    let any = false
    for (let i = 0; i < n; i++) {
      const my = cellChain[i]
      let sum = 0
      let cnt = 0
      for (let j = 0; j < n; j++) {
        if (cellChain[j] === my) continue
        sum += pae.bytes[i * n + j]
        cnt++
      }
      if (!cnt) continue
      any = true
      // every residue inside pooled cell i inherits the cell's cross-chain mean
      const first = i * scale
      const last = Math.min((i + 1) * scale, residues.length)
      for (let r = first; r < last; r++) out[r] = (sum / cnt / 255) * 32
    }
    return any ? out : null
  }, [pae, n, residues, scale])

  useEffect(() => {
    onInterface?.(interfaceErr ?? null)
  }, [onInterface, interfaceErr])

  // Cell-index range spanned by each chain — for the chip-click block outline.
  const chainRanges = useMemo(() => {
    if (!pae || !n || !residues || !residues.length) return null
    const ranges = {}
    for (let c = 0; c < n; c++) {
      const ch = residues[Math.min(c * scale, residues.length - 1)]?.chain ?? '?'
      if (!ranges[ch]) ranges[ch] = { start: c, end: c + 1 }
      else ranges[ch].end = c + 1
    }
    return ranges
  }, [pae, n, residues, scale])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !n) return
    const ctx2d = canvas.getContext('2d')
    const tmp = document.createElement('canvas')
    tmp.width = n
    tmp.height = n
    const tctx = tmp.getContext('2d')
    // Headless/test environments may lack a 2D context — skip drawing, the
    // canvas element itself still renders.
    if (!ctx2d || !tctx) return
    const img = tctx.createImageData(n, n)
    for (let k = 0; k < n * n; k++) {
      const [r, g, b] = viridisRgb(pae.bytes[k] / 255)
      img.data[k * 4] = r
      img.data[k * 4 + 1] = g
      img.data[k * 4 + 2] = b
      img.data[k * 4 + 3] = 255
    }
    tctx.putImageData(img, 0, 0)
    ctx2d.imageSmoothingEnabled = false
    ctx2d.clearRect(0, 0, px, px)
    ctx2d.drawImage(tmp, 0, 0, px, px)
    if (chainSizes && cell > 1) {
      ctx2d.strokeStyle = 'rgba(255,255,255,0.65)'
      ctx2d.lineWidth = 1
      let acc = 0
      for (let s = 0; s < chainSizes.length - 1; s++) {
        acc += chainSizes[s]
        // chain boundaries are residue-indexed; pooled cells cover `scale` each
        const line = (acc / scale) * cell + 0.5
        ctx2d.setLineDash([3, 3])
        ctx2d.beginPath()
        ctx2d.moveTo(line, 0)
        ctx2d.lineTo(line, px)
        ctx2d.moveTo(0, line)
        ctx2d.lineTo(px, line)
        ctx2d.stroke()
        ctx2d.setLineDash([])
      }
    }
    // Reverse linkage: a residue hovered in the 3D view / curve / strip draws a
    // crosshair over its row+column so the pair-error profile reads at a glance.
    if (hover != null && hover >= 0) {
      const line = Math.floor(hover / scale) * cell + 0.5
      if (line < px) {
        ctx2d.strokeStyle = 'rgba(255,255,255,0.85)'
        ctx2d.lineWidth = 1
        ctx2d.beginPath()
        ctx2d.moveTo(line, 0)
        ctx2d.lineTo(line, px)
        ctx2d.moveTo(0, line)
        ctx2d.lineTo(px, line)
        ctx2d.stroke()
      }
    }
    // Chip-clicked chain pair: outline both symmetric blocks of the submatrix
    // so the pair's error structure can be inspected in isolation.
    if (focusPair && chainRanges) {
      const ra = chainRanges[focusPair.a]
      const rb = chainRanges[focusPair.b]
      if (ra && rb) {
        ctx2d.strokeStyle = 'rgba(255,255,255,0.95)'
        ctx2d.lineWidth = 1.5
        ctx2d.strokeRect(ra.start * cell + 0.5, rb.start * cell + 0.5, (ra.end - ra.start) * cell - 1, (rb.end - rb.start) * cell - 1)
        ctx2d.strokeRect(rb.start * cell + 0.5, ra.start * cell + 0.5, (rb.end - rb.start) * cell - 1, (ra.end - ra.start) * cell - 1)
      }
    }
  }, [pae, n, px, cell, chainSizes, hover, scale, focusPair, chainRanges])

  // Side profile: one bar per (pooled) row = that residue's mean PAE against
  // all partners. Same hover linkage as the heatmap — the hovered row lights up.
  useEffect(() => {
    const canvas = stripRef.current
    if (!canvas || !rowMeans || !n) return
    const ctx2d = canvas.getContext('2d')
    if (!ctx2d) return
    const stripW = canvas.width
    ctx2d.clearRect(0, 0, stripW, px)
    for (let i = 0; i < n; i++) {
      const [r, g, b] = viridisRgb(rowMeans[i] / 255)
      ctx2d.fillStyle = `rgb(${r},${g},${b})`
      const w = Math.max(1, (rowMeans[i] / 255) * stripW)
      ctx2d.fillRect(0, i * cell, w, Math.max(1, cell - (cell > 2 ? 1 : 0)))
    }
    if (chainSizes && cell > 1) {
      ctx2d.strokeStyle = 'rgba(255,255,255,0.65)'
      ctx2d.lineWidth = 1
      ctx2d.setLineDash([3, 3])
      let acc = 0
      for (let s = 0; s < chainSizes.length - 1; s++) {
        acc += chainSizes[s]
        const line = (acc / scale) * cell + 0.5
        ctx2d.beginPath()
        ctx2d.moveTo(0, line)
        ctx2d.lineTo(stripW, line)
        ctx2d.stroke()
      }
      ctx2d.setLineDash([])
    }
    if (hover != null && hover >= 0) {
      const line = Math.floor(hover / scale) * cell
      if (line < px) {
        ctx2d.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx2d.lineWidth = 1
        ctx2d.strokeRect(0.5, line + 0.5, stripW - 1, Math.max(1, cell - 1))
      }
    }
  }, [rowMeans, n, px, cell, chainSizes, hover, scale])

  if (error || !pae) {
    return h(
      'div',
      { className: 'pv-pae' },
      h('div', { className: 'pv-section-title' }, 'PAE 误差热图'),
      error
        ? h('div', { className: 'pv-pae-note' }, `PAE 加载失败：${error}`)
        : h('div', { className: 'pv-pae-note' }, '加载 PAE 矩阵…'),
    )
  }

  // A pooled cell covers residues [c*scale, (c+1)*scale) — readouts show the
  // range (single label when scale is 1).
  const cellLabel = (c) => {
    const a = c * scale
    const b = Math.min((c + 1) * scale, residues?.length ?? a + 1) - 1
    const la = residues && residues[a] ? resLabel(residues, residues[a]) : `${a + 1}`
    if (b <= a) return la
    const lb = residues && residues[b] ? resLabel(residues, residues[b]) : `${b + 1}`
    return `${la}–${lb}`
  }
  const readout = hoverCell
    ? `${cellLabel(hoverCell.i)} → ${cellLabel(hoverCell.j)} · ${(pae.bytes[hoverCell.i * n + hoverCell.j] / 255 * 32).toFixed(2)} Å`
    : stripRow != null && rowMeans
      ? `${cellLabel(stripRow)} · 平均 ${(rowMeans[stripRow] / 255 * 32).toFixed(2)} Å`
      : ''

  return h(
    'div',
    { className: 'pv-pae' },
    h(
      'div',
      { className: 'pv-3d-toolbar' },
      h('div', { className: 'pv-section-title' }, `PAE 误差热图 · ${n}×${n}${scale > 1 ? `（每格 ${scale} 残基）` : ''}`),
      h(
        'div',
        { className: 'pv-toolbar-controls' },
        h(
          'div',
          { className: 'pv-pae-legend' },
          h('span', null, '0 Å'),
          h('div', { className: 'pv-pae-legendbar' }),
          h('span', null, '32 Å'),
        ),
        h(
          'button',
          { className: 'pv-export', onClick: (e) => exportPaePng(e, `${name}.pae.png`, n, pae.bytes, chainSizes, scale) },
          '导出 PNG',
        ),
        h(
          'button',
          { className: 'pv-export', onClick: () => exportPaeCsv(`${name}.pae.csv`, n, pae.bytes, residues, scale) },
          '导出 CSV',
        ),
      ),
    ),
    h(
      'div',
      { className: 'pv-pae-body' },
      h(
        'div',
        { style: { display: 'flex', gap: '6px', alignItems: 'flex-start' } },
        h('canvas', {
          ref: canvasRef,
          className: 'pv-pae-canvas',
          width: px,
          height: px,
          style: { width: `${px}px`, height: `${px}px` },
          onMouseMove: (e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            const i = Math.floor((e.clientX - rect.left) / (rect.width / n))
            const j = Math.floor((e.clientY - rect.top) / (rect.height / n))
            if (i < 0 || j < 0 || i >= n || j >= n) return
            setHoverCell({ i, j })
            // Sync the 3D/curve hover to the row's first residue — cross-view
            // linkage (pooled cells map back to residue i*scale).
            const r = i * scale
            if (residues && residues[r] && onHover) onHover(r)
          },
          onMouseLeave: () => setHoverCell(null),
        }),
        h('canvas', {
          ref: stripRef,
          className: 'pv-pae-strip',
          width: 28,
          height: px,
          style: { width: '28px', height: `${px}px` },
          onMouseMove: (e) => {
            const rect = e.currentTarget.getBoundingClientRect()
            const i = Math.floor((e.clientY - rect.top) / (rect.height / n))
            if (i < 0 || i >= n) return
            setStripRow(i)
            const r = i * scale
            if (residues && residues[r] && onHover) onHover(r)
          },
          onMouseLeave: () => setStripRow(null),
        }),
      ),
      h(
        'div',
        { className: 'pv-pae-side' },
        chainPairs?.length
          ? h(
              'div',
              { className: 'pv-pae-pairs' },
              chainPairs.map((p) =>
                h(
                  'button',
                  {
                    key: `${p.a}|${p.b}`,
                    className: 'pv-pae-pair' + (focusPair && focusPair.a === p.a && focusPair.b === p.b ? ' pv-pae-pair--on' : ''),
                    title: '链间平均 PAE——低值说明该链对的结合界面建模可信；点击在热图中框出该链对的误差块',
                    style: { background: `rgb(${viridisRgb(Math.min(1, p.meanA / 32)).join(',')})` },
                    onClick: () =>
                      setFocusPair((prev) => (prev && prev.a === p.a && prev.b === p.b ? null : { a: p.a, b: p.b })),
                  },
                  `${p.a}–${p.b} ${p.meanA.toFixed(2)} Å`,
                ),
              ),
            )
          : null,
        h('div', { className: 'pv-hoverline' }, readout),
        h(
          'div',
          { className: 'pv-pae-caption' },
          scale > 1
            ? `矩阵按 ${scale} 残基/格均值降采样显示；紫=低误差（可信），黄=高误差（≥32 Å 封顶）；虚线为链边界。右侧条形为各残基平均误差（不含自身）——长条提示界面或无序区。悬停读出并联动 3D。`
            : '紫=低误差（可信），黄=高误差（≥32 Å 封顶）；虚线为链边界，块外亮区提示接口或折叠不确定性。右侧条形为各残基平均误差（不含自身）——长条提示界面残基或无序区。悬停读出残基对误差并联动 3D。',
        ),
      ),
    ),
  )
}

function ProteinToolView({ owner, services }) {
  const block = owner?.block ?? {}
  // The transcript clips resultPreview at 4096 chars, which truncates large reports
  // (>20 search hits, big batch tables) into unparseable JSON. Tools therefore save
  // the full report into the workspace and put `savedTo` first in the result — the
  // clip keeps that key — and the panel re-fetches the whole report here.
  const previewRaw = typeof block.resultPreview === 'string' ? block.resultPreview : ''
  const clippedSavedTo = useMemo(() => {
    const m = /"savedTo"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(previewRaw)
    return m && !m[1].endsWith('.pdb') ? m[1].replace(/\\(.)/g, '$1') : null
  }, [previewRaw])
  const previewReport = useMemo(() => parseReport(block), [block])
  const [fetchedReport, setFetchedReport] = useState(null)
  useEffect(() => {
    setFetchedReport(null)
    if (!clippedSavedTo || previewReport) return
    let alive = true
    services
      .call('protein.report', { path: clippedSavedTo })
      .then((full) => {
        if (alive && full && typeof full === 'object') setFetchedReport(full)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [clippedSavedTo, previewReport, services])
  const report = previewReport ?? fetchedReport
  const pdbPath = useMemo(() => {
    const p = report?.savedTo ?? report?.file
    return typeof p === 'string' && p.endsWith('.pdb') ? p : null
  }, [report])
  const pdbName = pdbPath ? pdbPath.split('/').pop().replace(/\.pdb$/, '') || 'structure' : 'structure'

  const [structure, setStructure] = useState(null)
  const [loadError, setLoadError] = useState(null)
  const [hover, setHover] = useState(null)
  const [selected, setSelected] = useState(null)
  const [colorMode, setColorMode] = useState('plddt')
  const [autoSpin, setAutoSpin] = useState(true)
  const [seqCopied, setSeqCopied] = useState(false)
  const [hiddenChains, setHiddenChains] = useState(() => new Set())
  const [highlightSeg, setHighlightSeg] = useState(null)
  // Per-residue mean inter-chain PAE (Å), reported up by PaesModule once the
  // matrix loads; enables the "按界面误差着色" 3D mode on complex panels.
  const [interfaceErr, setInterfaceErr] = useState(null)
  const [showLigand, setShowLigand] = useState(true)
  // The service returns flat ligandAtoms/ligandBonds (nested object schemas are
  // rejected by the protocol); normalize to the { n, atoms, bonds } Structure3D expects.
  const ligandInfo = useMemo(
    () => (structure?.ligandAtoms?.length ? { n: structure.ligandAtoms.length, atoms: structure.ligandAtoms, bonds: structure.ligandBonds ?? [] } : null),
    [structure],
  )
  // Per-residue distance to the closest ligand atom (same Cα geometry the 3D
  // view draws) — pocket residues get a 距配体 readout on hover instead of
  // requiring the user to eyeball the contact lines.
  const ligandDist = useMemo(() => {
    if (!ligandInfo || !structure?.residues?.length) return null
    const atoms = ligandInfo.atoms
    return structure.residues.map((r) => {
      let m = Infinity
      for (const a of atoms) m = Math.min(m, Math.hypot(a.x - r.x, a.y - r.y, a.z - r.z))
      return m
    })
  }, [ligandInfo, structure])

  useEffect(() => {
    if (!pdbPath || !services) return
    let alive = true
    setStructure(null)
    setLoadError(null)
    setHiddenChains(new Set())
    setInterfaceErr(null)
    services
      .call('protein.structure', { path: pdbPath })
      .then((s) => {
        if (alive && s && Array.isArray(s.residues)) setStructure(s)
      })
      .catch((e) => {
        if (alive) setLoadError(String(e?.message ?? e).slice(0, 200))
      })
    return () => {
      alive = false
    }
  }, [pdbPath, services])

  const residues = structure?.residues ?? null
  const segRange = useMemo(() => (highlightSeg ? parseSeg(highlightSeg) : null), [highlightSeg])
  // Chain visibility: toggle from the legend chips; the last visible chain
  // can't be hidden (an empty canvas would read as "broken").
  const toggleChain = useCallback((c) => {
    setHiddenChains((prev) => {
      const n = new Set(prev)
      if (n.has(c)) {
        n.delete(c)
        return n
      }
      const chains = new Set((structure?.residues ?? []).map((r) => r.chain))
      const visible = [...chains].filter((x) => !n.has(x))
      if (visible.length <= 1) return prev
      n.add(c)
      return n
    })
  }, [structure])

  // Multi-chain complexes (Boltz-2) default to per-chain coloring once loaded.
  useEffect(() => {
    if (structure && isMultiChain(structure.residues)) setColorMode('chain')
  }, [structure])

  // Keyboard stepping (and every other selection path) keeps the hoverline in
  // sync; idempotent for click/jump which already set hover themselves.
  useEffect(() => {
    if (selected != null) setHover(selected)
  }, [selected])

  // uniprot_search results render as a structured hit table (click to copy
  // the accession) instead of falling into the confidence panel.
  if (report?.hits) {
    return h('div', { className: 'pv-root' }, h(SearchCard, { report }))
  }

  // compare_alphafold results have a different shape (no meanPlddt at top level);
  // render the comparison card instead of the confidence panel.
  if (report?.compared) {
    return h('div', { className: 'pv-root' }, h(CompareCard, { report, services }))
  }

  // batch_predict results render as a per-accession table.
  if (report?.jobs) {
    return h('div', { className: 'pv-root' }, h(BatchCard, { report, services }))
  }

  if (!report) {
    return h(
      'div',
      { className: 'pv-root pv-root--fallback' },
      h('div', { className: 'pv-fallback' }, typeof block.resultPreview === 'string'
        ? block.resultPreview.slice(0, 400)
        : '（无结构结果预览）'),
    )
  }

  return h(
    'div',
    {
      className: 'pv-root',
      tabIndex: 0,
      onKeyDown: (e) => {
        if (!residues || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
        e.preventDefault()
        const delta = e.key === 'ArrowRight' ? 1 : -1
        // Functional update: rapid keypresses in one tick must not reuse a
        // stale closure value (React batches synchronous dispatches).
        setSelected((prev) => Math.max(0, Math.min(residues.length - 1, (prev ?? -1) + delta)))
      },
    },
    h(ConfidenceSummary, { report }),
    h(SegmentChips, {
      segments: report.lowConfidenceSegments,
      selected: highlightSeg,
      onSelect: (s) => setHighlightSeg(s),
    }),
    residues
      ? h(
          'div',
          { className: 'pv-grid' },
          h(
            'div',
            { className: 'pv-3d-col' },
            h(
              'div',
              { className: 'pv-3d-toolbar' },
              h('div', { className: 'pv-section-title' }, `3D 骨架 · Cα (${structure.n} aa)`),
              h(
                'div',
                { className: 'pv-toolbar-controls' },
                h(
                  'select',
                  {
                    className: 'pv-select',
                    value: colorMode,
                    onChange: (e) => setColorMode(e.target.value),
                  },
                  h('option', { value: 'plddt' }, '按 pLDDT 着色'),
                  h('option', { value: 'rainbow' }, '彩虹 (N→C)'),
                  isMultiChain(residues) ? h('option', { value: 'chain' }, '按链着色') : null,
                  interfaceErr ? h('option', { value: 'interface' }, '按界面误差着色') : null,
                ),
                h(
                  'label',
                  { className: 'pv-toggle' },
                  h('input', {
                    type: 'checkbox',
                    checked: autoSpin,
                    onChange: (e) => setAutoSpin(e.target.checked),
                  }),
                  '自动旋转',
                ),
                ligandInfo
                  ? h(
                      'label',
                      { className: 'pv-toggle', title: '显示/隐藏配体（HETATM 原子，按元素着色）' },
                      h('input', {
                        type: 'checkbox',
                        checked: showLigand,
                        onChange: (e) => setShowLigand(e.target.checked),
                      }),
                      `配体 (${ligandInfo.n})`,
                    )
                  : null,
                h(
                  'button',
                  { className: 'pv-export', onClick: (e) => export3DPng(e, `${pdbName}.3d.png`, residues, colorMode) },
                  '导出 PNG',
                ),
                h(
                  'button',
                  {
                    className: 'pv-export',
                    onClick: () => {
                      if (!residues) return
                      try {
                        void navigator.clipboard?.writeText(fastaOf(residues, pdbName))
                      } catch {
                        // Clipboard unavailable — sequence stays visible in the strip.
                      }
                      setSeqCopied(true)
                      setTimeout(() => setSeqCopied(false), 1600)
                    },
                    title: '复制 FASTA 序列（多链复合物按链分条）',
                  },
                  seqCopied ? '已复制 ✓' : '复制序列',
                ),
                h('input', {
                  className: 'pv-jump',
                  placeholder: isMultiChain(residues) ? '残基号或 B:17…' : '残基号 / K101…',
                  title: isMultiChain(residues)
                    ? '输入残基号或 链:残基号（如 B:17）回车，3D 与曲线同步高亮'
                    : '输入残基号、氨基酸+编号（如 K101）回车，3D 与曲线同步高亮',
                  onKeyDown: (e) => {
                    if (e.key !== 'Enter') return
                    if (!residues) return
                    const raw = e.currentTarget.value.trim()
                    const cm = /^([A-Za-z][A-Za-z0-9]{0,2}):(\d+)$/.exec(raw)
                    // single-chain panels also accept aa+number ("K101") — ambiguous
                    // with chain letters on complexes, so only offered there
                    const am = !isMultiChain(residues) ? /^([A-Za-z])(\d+)$/.exec(raw) : null
                    const idx = cm
                      ? residues.findIndex((r) => r.chain && r.chain.toUpperCase() === cm[1].toUpperCase() && r.i === Number(cm[2]))
                      : am
                        ? residues.findIndex((r) => r.i === Number(am[2]) && (r.aa ?? '')[0]?.toUpperCase() === am[1].toUpperCase())
                        : residues.findIndex((r) => r.i === Number(raw))
                    if (idx >= 0) {
                      setSelected(idx)
                      setHover(idx)
                      e.currentTarget.value = ''
                    }
                  },
                }),
              ),
            ),
            segRange
              ? h(
                  'div',
                  { className: 'pv-fmt' },
                  `聚焦区段 ${segRange.chain ? `${segRange.chain}:` : ''}${segRange.a}–${segRange.b}`,
                )
              : null,
            h(Structure3D, {
              residues,
              hover,
              onHover: setHover,
              selected,
              onSelect: (k) => {
                setSelected((prev) => (prev === k ? null : k))
                setHover(k)
              },
              colorMode,
              autoSpin,
              interfaceErr,
              ligand: ligandInfo,
              showLigand,
              hiddenChains,
            }),
            colorMode === 'chain' ? h(ChainLegend, { residues, hidden: hiddenChains, onToggle: toggleChain }) : null,
            colorMode === 'interface' ? h(InterfaceLegend) : null,
            ligandInfo && showLigand ? h(LigandLegend) : null,
            h(
              'div',
              { className: 'pv-hoverline' },
              hover != null && hover < 0 && ligandInfo
                ? (() => {
                    // negative hover = ligand atom (-1 - index), from the 3D pick
                    const a = ligandInfo.atoms[-1 - hover]
                    if (!a) return ''
                    let m = Infinity
                    let mk = null
                    residues.forEach((r, k) => {
                      const d = Math.hypot(a.x - r.x, a.y - r.y, a.z - r.z)
                      if (d < m) {
                        m = d
                        mk = k
                      }
                    })
                    return `配体原子 ${a.el}${mk != null ? ` · 距最近残基 ${resLabel(residues, residues[mk])} ${m.toFixed(1)} Å` : ''}`
                  })()
                : hover != null && residues[hover]
                  ? (colorMode === 'interface' && interfaceErr
                      ? `${resLabel(residues, residues[hover])} · 界面误差 ${interfaceErr[hover].toFixed(2)} Å`
                      : `${resLabel(residues, residues[hover])} · pLDDT ${residues[hover].b.toFixed(1)}`) +
                    (ligandDist && ligandDist[hover] <= 6 ? ` · 距配体 ${ligandDist[hover].toFixed(1)} Å` : '')
                  : selected != null && residues[selected]
                    ? `已选 ${resLabel(residues, residues[selected])} · pLDDT ${residues[selected].b.toFixed(1)}（点击曲线取消）` +
                      (ligandDist && ligandDist[selected] <= 6 ? ` · 距配体 ${ligandDist[selected].toFixed(1)} Å` : '')
                    : '',
            ),
          ),
          h(
            'div',
            { className: 'pv-curve-col' },
            h(
              'div',
              { className: 'pv-3d-toolbar' },
              h('div', { className: 'pv-section-title' }, 'pLDDT 置信度曲线'),
              h(
                'div',
                { className: 'pv-toolbar-controls' },
                h(
                  'button',
                  { className: 'pv-export', onClick: (e) => exportCurvePng(e, `${pdbName}.plddt.png`, residues) },
                  '导出 PNG',
                ),
                h(
                  'button',
                  { className: 'pv-export', onClick: () => exportResiduesCsv(`${pdbName}.plddt.csv`, residues, interfaceErr) },
                  '导出 CSV',
                ),
              ),
            ),
            h(Curve, {
              residues,
              hover,
              onHover: setHover,
              selected,
              onSelect: (idx) => setSelected((prev) => (prev === idx ? null : idx)),
              highlight: highlightSeg,
              noTitle: true,
            }),
            h(SequenceStrip, {
              residues,
              hover,
              onHover: setHover,
              selected,
              onSelect: (idx) => setSelected((prev) => (prev === idx ? null : idx)),
            }),
          ),
        )
      : h(
          'div',
          { className: 'pv-loading' },
          loadError
            ? `结构加载失败：${loadError}`
            : h(
                'div',
                { className: 'pv-loading-inner' },
                h('div', { className: 'pv-spinner' }),
                '加载结构…',
              ),
        ),
    report.paePath
      ? h(PaesModule, { paePath: report.paePath, residues, services, onHover: setHover, hover, onInterface: setInterfaceErr, name: pdbName })
      : null,
  )
}

export function apply(ctx) {
  const services = ctx.agnes?.services
  const view = (owner) => h(ProteinToolView, { owner, services })
  const KEYS = ['predict_structure', 'analyze_confidence', 'compare_alphafold', 'predict_complex', 'batch_predict', 'compare_structures', 'uniprot_search']
  const SLOT = 'tool.call.toolview'

  // Slot components receive { owner }; bind the services facade once here.
  const makeSlot = () =>
    function ProteinViewSlot({ owner }) {
      return view(owner)
    }

  // The transcript builtin unmounts/remounts on session switches, and each unmount
  // collapses the shared `tool.call.toolview` child record — wiping every entry in
  // it, including plugin-owned ones (web-slots collapseChildren). Re-assert our
  // entries whenever the slot gets re-declared; idempotent by key check.
  const ensureRegistered = () => {
    try {
      if (!ctx.slots.spec?.(SLOT)) return
      const existing = new Set(ctx.slots.entriesOfSlot(SLOT).map((e) => e.options?.key))
      for (const key of KEYS) {
        if (existing.has(key)) continue
        ctx.slots.register(
          { name: SLOT, key, id: `protein-view-${key}`, priority: 20 },
          makeSlot(),
        )
      }
    } catch {
      // The slot may be mid-collapse (undeclared); the next declaration event retries.
    }
  }

  ensureRegistered()
  try {
    const stop = ctx.slots.subscribeDeclaration?.(SLOT, ensureRegistered)
    if (typeof stop === 'function') ctx.effect(() => stop)
  } catch {
    // Registry without declaration subscriptions: initial registration still stands.
  }
}
