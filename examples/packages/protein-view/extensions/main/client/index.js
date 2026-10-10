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
const isMultiChain = (residues) => Array.isArray(residues) && residues.length > 1 && residues.some((r) => r.chain && r.chain !== residues[0].chain)

function ChainLegend({ residues }) {
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
    stats.map((s, k) =>
      h(
        'span',
        { className: 'pv-chain-chip', key: s.chain ?? k },
        h('span', { className: 'pv-chain-dot', style: { background: CHAIN_COLORS[k % CHAIN_COLORS.length] } }),
        `链 ${s.chain} · ${s.n} aa · 均值 pLDDT ${s.mean.toFixed(1)}`,
      ),
    ),
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
    report.ligandIptm != null && ['ligand ipTM', report.ligandIptm],
    report.proteinIptm != null && ['protein ipTM', report.proteinIptm],
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
function DeltaSparkline({ series, note }) {
  if (!Array.isArray(series) || series.length < 2) return null
  const maxAbs = Math.max(...series.map((d) => Math.abs(d.delta)), 1)
  const n = series.length
  return h(
    'div',
    { className: 'pv-delta' },
    h('div', { className: 'pv-section-title' }, '逐残基 pLDDT 差值轮廓'),
    h(
      'div',
      { className: 'pv-delta-bars', role: 'img', 'aria-label': 'ΔpLDDT profile' },
      series.map((d, i) =>
        h('div', {
          key: i,
          className: `pv-delta-bar ${d.delta >= 0 ? 'pv-delta-bar--pos' : 'pv-delta-bar--neg'}`,
          style: {
            left: `${(i / n) * 100}%`,
            width: `${(100 / n) * 0.86}%`,
            height: `${Math.max((Math.abs(d.delta) / maxAbs) * 48, 4)}%`,
            ...(d.delta >= 0 ? { bottom: '50%' } : { top: '50%' }),
          },
          title: `残基 ${d.residue} 起 · Δ ${d.delta > 0 ? '+' : ''}${d.delta}`,
        }),
      ),
    ),
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
        ),
      h(Structure3D, {
        residues: pred.residues,
        colorMode: isMultiChain(pred.residues) ? 'chain' : 'plddt',
        autoSpin: true,
        ghost: ghostResidues,
        hover,
        onHover: setHover,
        onSelect: (k) => {
          const r = pred.residues[k]
          if (r) onPickRes?.(r.i)
        },
        selected: selIdx != null && selIdx >= 0 ? selIdx : undefined,
        hintText: `拖拽旋转 · 滚轮缩放 · 双击复位 · 灰色为 ${pw ? pw[1] : 'AlphaFold 参考模型'}`,
      }),
      isMultiChain(pred.residues) ? h(ChainLegend, { residues: pred.residues }) : null,
      h('div', { className: 'pv-hoverline' }, hoverLine),
      ),
    ),
    // Divergence strip: pred residues colored by |ΔpLDDT| vs the reference —
    // hot spots read as a horizontal heat map aligned with the sequence.
    ghostResidues
      ? h(SequenceStrip, {
          residues: pred.residues,
          hover,
          onHover: setHover,
          selected: selIdx != null && selIdx >= 0 ? selIdx : undefined,
          onSelect: (idx) => {
            const r = pred.residues[idx]
            if (r) onPickRes?.(r.i)
          },
          colorOf: (r) => (gmap.has(r.i) ? deltaColor(r.b - gmap.get(r.i)) : '#b6b6b6'),
          titleOf: (r) => {
            const g = gmap.get(r.i)
            const d = g != null ? ` · ${pw ? pw[1] : '参考'} ${g.toFixed(1)} · Δ ${(r.b - g).toFixed(1)}` : ' · 参考无此残基'
            return `${resLabel(pred.residues, r)} · ${pw ? pw[0] : '预测'} ${r.b.toFixed(1)}${d}`
          },
        })
      : null,
    h(
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
    h('div', { className: 'pv-complex-metrics' }, chips.map(([label, value]) =>
      h('span', { key: label, className: 'pv-metric-chip' },
        h('span', { className: 'pv-metric-label' }, label),
        h('span', { className: 'pv-metric-value' }, value)))),
    h(Compare3D, {
      report,
      services,
      selectedRes: selRes,
      onPickRes: (i) => setSelRes((prev) => (prev === i ? null : i)),
    }),
    h(DeltaSparkline, { series: c.deltaSeries, note: c.deltaSeriesNote }),
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
  const hits = Array.isArray(report.hits) ? report.hits : []
  const copy = (acc) => {
    try {
      void navigator.clipboard?.writeText(acc)
    } catch {
      // Clipboard may be unavailable; the row still shows the accession.
    }
    setCopied(acc)
    setTimeout(() => setCopied((c) => (c === acc ? null : c)), 1500)
  }
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
            h('span', null, 'Accession'),
            h('span', null, '蛋白'),
            h('span', null, '物种'),
            h('span', { className: 'pv-search-len' }, '长度'),
          ),
          ...hits.map((hit, k) =>
            h(
              'button',
              {
                className: 'pv-search-row',
                key: hit.accession ?? k,
                title: `点击复制 ${hit.accession ?? ''}`,
                onClick: () => copy(hit.accession),
              },
              h('span', { className: 'pv-search-acc' }, hit.accession ?? '—', copied === hit.accession ? ' ✓' : ''),
              h('span', { className: 'pv-search-name' }, hit.proteinName ?? hit.id ?? '—'),
              h('span', { className: 'pv-search-org' }, hit.organism ?? '—'),
              h('span', { className: 'pv-search-len' }, hit.length != null ? `${hit.length} aa` : '—'),
            ),
          ),
        )
      : h('div', { className: 'pv-fallback' }, '没有匹配的蛋白，换个关键词再试。'),
    h('div', { className: 'pv-search-hint' }, '点击行复制 accession；回复「预测 <accession>」继续，或用 batch_predict 一次预测多个。'),
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
function Structure3D({ residues, hover, onHover, selected, onSelect, colorMode, autoSpin, ghost, hintText }) {
  const canvasRef = useRef(null)
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
    return { centered, bonds, radius: maxR || 1, ghostCentered, ghostBonds, chainIdx }
  }, [residues, ghost])

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
        return hexToRgb(bandColor(r.b))
      }

      // Bonds back → front
      const items = geo.bonds
        .map(([a, b]) => ({ kind: 'bond', a, b, z: (projected[a].z + projected[b].z) / 2 }))
        .concat(projected.map((p, k) => ({ kind: 'ca', k, z: p.z })))
      if (ghostProjected && geo.ghostBonds) {
        for (const [a, b] of geo.ghostBonds) {
          items.push({ kind: 'ghost', a, b, z: (ghostProjected[a].z + ghostProjected[b].z) / 2 })
        }
      }
      items.sort((m, n2) => m.z - n2.z)

      for (const it of items) {
        if (it.kind === 'ghost') {
          const p1 = ghostProjected[it.a]
          const p2 = ghostProjected[it.b]
          const d = depth01(it.z)
          ctx2d.strokeStyle = `rgba(158,168,186,${0.55 * (1 - 0.55 * d)})`
          ctx2d.lineWidth = 0.9 + 0.9 * (1 - d)
          ctx2d.lineCap = 'round'
          ctx2d.beginPath()
          ctx2d.moveTo(p1.x, p1.y)
          ctx2d.lineTo(p2.x, p2.y)
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
  }, [geo, size, residues, hover, selected, colorMode, autoSpin, ghost])

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
      return best
    },
    [geo],
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
          if (k != null) onSelect(k)
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
    h('div', { className: 'pv-3d-hint' }, hintText ?? '拖拽旋转 · 滚轮缩放 · 双击复位'),
  )
}

// ---------------------------------------------------------------------------
// Tool view root. Registered for both tools; degrades gracefully per data availability.
function ProteinToolView({ owner, services }) {
  const block = owner?.block ?? {}
  const report = useMemo(() => parseReport(block), [block])
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
  const [highlightSeg, setHighlightSeg] = useState(null)

  useEffect(() => {
    if (!pdbPath || !services) return
    let alive = true
    setStructure(null)
    setLoadError(null)
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
                h(
                  'button',
                  { className: 'pv-export', onClick: (e) => export3DPng(e, `${pdbName}.3d.png`, residues, colorMode) },
                  '导出 PNG',
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
            }),
            colorMode === 'chain' ? h(ChainLegend, { residues }) : null,
            h(
              'div',
              { className: 'pv-hoverline' },
              hover != null && residues[hover]
                ? `${resLabel(residues, residues[hover])} · pLDDT ${residues[hover].b.toFixed(1)}`
                : selected != null && residues[selected]
                  ? `已选 ${resLabel(residues, residues[selected])} · pLDDT ${residues[selected].b.toFixed(1)}（点击曲线取消）`
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
