// Shareable single-file report: snapshot the rendered stage (3D + curve
// canvases) plus the headline numbers into one self-contained HTML the
// researcher can drop into a deck, an email or a notebook — no app, no server.
// The full report JSON rides along in a <script> block so nothing is lost.

type ShareInput = {
  taskId: string
  title: string
  typeLabel: string
  savedAt: string | number
  meanPlddt?: number
  verdict?: string
  report?: unknown
  // Optional residue payload (protein.structure output shape) — when present the
  // report embeds an interactive (draggable/zoomable) 3D viewer next to the
  // static PNG snapshots. Absent on failures/empty stages: degrades gracefully.
  structure?: { residues?: StructureResidue[]; ligandAtoms?: StructureLigand[] }
}

type StructureResidue = { x: number; y: number; z: number; b: number; aa?: string; chain?: string }
type StructureLigand = { el: string; x: number; y: number; z: number }

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch)

type StageFig = { caption: string; data: string }

function figCaption(c: HTMLCanvasElement, index: number): string {
  if (c.classList.contains('pv-3d')) return '3D 结构 · 按 pLDDT 着色'
  if (c.classList.contains('pv-curve')) return 'pLDDT 置信度曲线 · 序列置信带'
  return `结构图 ${index + 1}`
}

function scoreColor(v?: number): string {
  if (v == null) return '#6f7d96'
  if (v >= 90) return '#0053D6'
  if (v >= 70) return '#65CBF3'
  if (v >= 50) return '#FFDB13'
  return '#FF7D45'
}

/** Call this SYNCHRONOUSLY in the click handler — WebGL canvases only composite
 *  reliably while their frame is fresh, and any await before toDataURL risks a
 *  cleared buffer (or, worse, a stage remount replacing the canvases outright). */
export function snapshotStageFigures(): StageFig[] {
  return [...document.querySelectorAll<HTMLCanvasElement>('.pl-stage-wrap canvas')]
    .map((c, i) => {
      try {
        return { caption: figCaption(c, i), data: c.toDataURL('image/png') }
      } catch {
        return null
      }
    })
    .filter((f): f is StageFig => !!f?.data)
}

export function downloadShareReport(input: ShareInput & { figs?: StageFig[] }): void {
  const figs = input.figs ?? snapshotStageFigures()

  const when = new Date(input.savedAt).toLocaleString('zh-CN')
  const scoreBlock = input.meanPlddt != null
    ? `<div class="score" style="color:${scoreColor(input.meanPlddt)}">${input.meanPlddt.toFixed(1)}</div>
       <div class="score-label">平均 pLDDT${input.verdict ? ` · ${esc(input.verdict)}` : ''}</div>`
    : input.verdict
      ? `<div class="score-label" style="font-size:15px">${esc(input.verdict)}</div>`
      : ''

  const figsHtml = figs
    .map(
      (f) =>
        `<figure><img src="${f.data}" alt="${esc(f.caption)}" /><figcaption>${esc(f.caption)}</figcaption></figure>`,
    )
    .join('\n')

  const reportHtml = input.report
    ? `<details><summary>完整报告数据（JSON）</summary><pre>${esc(JSON.stringify(input.report, null, 2))}</pre></details>`
    : ''

  // Interactive 3D: a self-contained canvas viewer (Cα trace + pLDDT-colored
  // residues, ligand balls) — drag rotate, wheel zoom, double-click reset,
  // auto-rotate toggle. All vanilla JS inline; PNG figures above stay for print.
  const res = input.structure?.residues ?? []
  const lig = input.structure?.ligandAtoms ?? []
  const viewerHtml =
    res.length > 0
      ? `<section class="viewer">
  <div class="viewer-head">
    <strong>可交互 3D 视图</strong>
    <span class="viewer-hint">拖拽旋转 · 滚轮缩放 · 双击复位</span>
    <button id="pv-spin" type="button">⏸ 暂停自动旋转</button>
  </div>
  <canvas id="pv3d"></canvas>
</section>
<script id="pv-data" type="application/json">${JSON.stringify({ residues: res, ligands: lig })}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('pv-data').textContent)
  var R = data.residues, L = data.ligands || []
  var cv = document.getElementById('pv3d'), ctx2d = cv.getContext('2d')
  var spin = true, dragging = false, rx = -0.35, ry = 0.6, zoom = 1, lastX = 0, lastY = 0
  var cx = 0, cy = 0, cz = 0, rad = 1
  for (var k = 0; k < R.length; k++) { cx += R[k].x; cy += R[k].y; cz += R[k].z }
  cx /= R.length; cy /= R.length; cz /= R.length
  for (k = 0; k < R.length; k++) {
    var dx = R[k].x - cx, dy = R[k].y - cy, dz = R[k].z - cz
    var d = Math.sqrt(dx*dx + dy*dy + dz*dz); if (d > rad) rad = d
  }
  function palette(b) { return b >= 90 ? '#0053D6' : b >= 70 ? '#65CBF3' : b >= 50 ? '#FFDB13' : '#FF7D45' }
  var LIGCOL = { C: '#8a929e', O: '#d9534f', N: '#3d6ac4', S: '#d4a017', P: '#7b5cd6' }
  function sizeCanvas() {
    var w = cv.clientWidth || 800, dpr = window.devicePixelRatio || 1
    cv.width = Math.round(w * dpr); cv.height = Math.round(w * 0.58 * dpr)
    cv.style.height = Math.round(w * 0.58) + 'px'
  }
  function draw() {
    var w = cv.width, h = cv.height, dpr = window.devicePixelRatio || 1
    var s = (Math.min(w, h) * 0.44 / (rad || 1)) * zoom
    ctx2d.fillStyle = '#ffffff'; ctx2d.fillRect(0, 0, w, h)
    var cyr = Math.cos(ry), syr = Math.sin(ry), cxr = Math.cos(rx), sxr = Math.sin(rx)
    function proj(p) {
      var x = p.x - cx, y = p.y - cy, z = p.z - cz
      var x1 = x * cyr + z * syr, z1 = -x * syr + z * cyr
      var y2 = y * cxr - z1 * sxr, z2 = y * sxr + z1 * cxr
      return [w / 2 + x1 * s, h / 2 - y2 * s, z2]
    }
    var prims = []
    for (var i = 0; i < R.length; i++) {
      var q = proj(R[i])
      prims.push({ z: q[2], kind: 'ball', x: q[0], y: q[1], r: 2.6 * dpr * Math.min(zoom, 2), c: palette(R[i].b) })
      var nx = R[i + 1]
      if (nx && nx.chain === R[i].chain) {
        var q2 = proj(nx)
        prims.push({ z: (q[2] + q2[2]) / 2, kind: 'line', x1: q[0], y1: q[1], x2: q2[0], y2: q2[1] })
      }
    }
    for (i = 0; i < L.length; i++) {
      var ql = proj(L[i])
      prims.push({ z: ql[2], kind: 'ball', x: ql[0], y: ql[1], r: 2.2 * dpr * Math.min(zoom, 2), c: LIGCOL[L[i].el] || '#8a929e' })
    }
    prims.sort(function (a, b) { return a.z - b.z })
    ctx2d.lineWidth = 1.1 * dpr; ctx2d.strokeStyle = 'rgba(120,132,150,0.55)'
    for (i = 0; i < prims.length; i++) {
      var p = prims[i]
      if (p.kind === 'line') { ctx2d.beginPath(); ctx2d.moveTo(p.x1, p.y1); ctx2d.lineTo(p.x2, p.y2); ctx2d.stroke() }
      else { ctx2d.beginPath(); ctx2d.arc(p.x, p.y, p.r, 0, 6.2832); ctx2d.fillStyle = p.c; ctx2d.fill() }
    }
  }
  var btn = document.getElementById('pv-spin')
  btn.addEventListener('click', function () {
    spin = !spin
    btn.textContent = spin ? '⏸ 暂停自动旋转' : '▶ 自动旋转'
    if (spin) requestAnimationFrame(loop)
  })
  cv.addEventListener('mousedown', function (e) { dragging = true; lastX = e.clientX; lastY = e.clientY })
  window.addEventListener('mousemove', function (e) {
    if (!dragging) return
    ry += (e.clientX - lastX) * 0.008; rx += (e.clientY - lastY) * 0.008
    lastX = e.clientX; lastY = e.clientY; draw()
  })
  window.addEventListener('mouseup', function () { dragging = false })
  cv.addEventListener('wheel', function (e) {
    e.preventDefault()
    zoom *= e.deltaY < 0 ? 1.12 : 0.89
    if (zoom < 0.35) zoom = 0.35; if (zoom > 8) zoom = 8
    draw()
  }, { passive: false })
  cv.addEventListener('dblclick', function () { rx = -0.35; ry = 0.6; zoom = 1; draw() })
  // Touch: one-finger rotate, pinch zoom.
  var touches = {}
  cv.addEventListener('touchstart', function (e) {
    for (var i = 0; i < e.changedTouches.length; i++) touches[e.changedTouches[i].identifier] = e.changedTouches[i]
  })
  cv.addEventListener('touchmove', function (e) {
    e.preventDefault()
    var ids = Object.keys(touches)
    if (e.changedTouches.length === 1 && ids.length <= 1) {
      var t = e.changedTouches[0], p = touches[t.identifier]
      if (p) { ry += (t.clientX - p.clientX) * 0.008; rx += (t.clientY - p.clientY) * 0.008 }
    } else if (e.changedTouches.length === 2 && ids.length >= 2) {
      var a = e.changedTouches[0], b = e.changedTouches[1]
      var pa = touches[a.identifier], pb = touches[b.identifier]
      if (pa && pb) {
        var d0 = Math.hypot(pa.clientX - pb.clientX, pa.clientY - pb.clientY)
        var d1 = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        if (d0 > 0) { zoom *= d1 / d0; if (zoom < 0.35) zoom = 0.35; if (zoom > 8) zoom = 8 }
      }
    }
    for (var i = 0; i < e.changedTouches.length; i++) touches[e.changedTouches[i].identifier] = e.changedTouches[i]
    draw()
  }, { passive: false })
  window.addEventListener('touchend', function (e) {
    for (var i = 0; i < e.changedTouches.length; i++) delete touches[e.changedTouches[i].identifier]
  })
  var lastFrame = 0
  function loop(ts) {
    if (spin && !dragging && (!ts || ts - lastFrame > 33)) { ry += 0.012; lastFrame = ts; draw() }
    if (spin) requestAnimationFrame(loop)
  }
  window.addEventListener('resize', function () { sizeCanvas(); draw() })
  sizeCanvas(); draw(); requestAnimationFrame(loop)
})()
</script>`
      : ''

  const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(input.title)} · 蛋白质结构预测报告</title>
<style>
  body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, 'PingFang SC', sans-serif;
         color: #1f2430; background: #f6f7f9; }
  .page { max-width: 960px; margin: 0 auto; padding: 36px 24px 48px; }
  header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
  h1 { font-size: 22px; margin: 0; }
  .badge { font-size: 12px; background: #e8f0fe; color: #2b5fc7; border-radius: 999px; padding: 3px 10px; }
  .meta { color: #6f7d96; font-size: 13px; margin-top: 6px; }
  .hero { background: #fff; border: 1px solid #e6e9ef; border-radius: 14px; padding: 22px 26px;
          margin: 18px 0; text-align: center; }
  .score { font-size: 44px; font-weight: 700; line-height: 1; }
  .score-label { color: #6f7d96; font-size: 13px; margin-top: 6px; }
  figure { background: #fff; border: 1px solid #e6e9ef; border-radius: 14px; margin: 18px 0;
           padding: 16px; }
  figure img { width: 100%; height: auto; display: block; }
  figcaption { color: #6f7d96; font-size: 12.5px; margin-top: 10px; text-align: center; }
  details { background: #fff; border: 1px solid #e6e9ef; border-radius: 14px; margin: 18px 0;
            padding: 14px 18px; }
  summary { cursor: pointer; color: #2b5fc7; font-size: 14px; }
  pre { overflow: auto; max-height: 480px; font-size: 12px; background: #f6f7f9;
        border-radius: 8px; padding: 12px; }
  footer { color: #9aa5b5; font-size: 12px; margin-top: 26px; text-align: center; }
  .viewer { background: #fff; border: 1px solid #e6e9ef; border-radius: 14px; margin: 18px 0;
            padding: 16px; }
  .viewer-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
  .viewer-head strong { font-size: 15px; }
  .viewer-hint { color: #6f7d96; font-size: 12.5px; flex: 1; }
  .viewer-head button { font-size: 12.5px; border: 1px solid #c9d4ee; background: #f1f4fb;
                        color: #2b5fc7; border-radius: 8px; padding: 4px 12px; cursor: pointer; }
  #pv3d { width: 100%; border-radius: 8px; background: #fff; cursor: grab; touch-action: none;
          display: block; }
  #pv3d:active { cursor: grabbing; }
  @media print { body { background: #fff; } .page { padding: 0; } }
</style>
</head>
<body>
<div class="page">
  <header>
    <h1>${esc(input.title)}</h1>
    <span class="badge">${esc(input.typeLabel)}</span>
  </header>
  <div class="meta">任务 ${esc(input.taskId)} · ${esc(when)} · 由蛋白质预测工作台生成</div>
  <div class="hero">${scoreBlock}</div>
  ${viewerHtml}
  ${figsHtml || '<p class="meta">（本报告生成时画布未渲染，快照为空）</p>'}
  ${reportHtml}
  <footer>pLDDT 置信度色标：≥90 很高（深蓝）· 70–90 高（浅蓝）· 50–70 中（黄）· &lt;50 低（橙）</footer>
</div>
</body>
</html>`

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${(input.title || input.taskId).replace(/[\\/:*?"<>|\s]+/g, '_')}-报告.html`
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}
