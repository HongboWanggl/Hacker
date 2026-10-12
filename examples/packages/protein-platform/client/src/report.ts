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
}

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
