import { useState } from 'react'
import { runTask } from '../orchestrator.ts'

// 批量预测：每行一个 UniProt ID（≤8），batch_predict 串行预测后由 BatchCard
// 汇总渲染（成功行可展开逐目标 3D 详情）。
export function BatchView({ ready, cfg, sdk }: { ready: boolean; cfg: any; sdk: any }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const accessions = text
    .split(/[\n,;\s]+/)
    .map((s) => s.trim())
    .filter((s) => /^[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]$|^[OPQ][0-9][A-Z0-9]{3}[0-9]$/i.test(s))
  const submit = async () => {
    if (!ready || busy || accessions.length === 0) return
    setBusy(true)
    try {
      await runTask(cfg, sdk, 'batch', { accessions: accessions.slice(0, 8).map((a) => a.toUpperCase()) })
      setText('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="pl-page">
      <div className="pl-hero" style={{ padding: '12px 0 20px' }}>
        <h1>批量预测</h1>
        <p>一次提交最多 8 个 UniProt ID，逐个预测并汇总质量分布</p>
      </div>
      <div className="pl-composer">
        <textarea
          placeholder={'每行一个 UniProt ID（≤8 个）：\nP69905\nP68871\nP04637'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit()
          }}
        />
        <div className="pl-composer-foot">
          <span className="pl-card-sub">
            识别到 {accessions.length} 个 ID{accessions.length > 8 ? '（取前 8 个）' : ''}
          </span>
          <button
            className="pl-submit"
            disabled={!ready || busy || accessions.length === 0}
            onClick={() => void submit()}
          >
            {busy ? '提交中…' : '批量预测 →'}
          </button>
        </div>
      </div>
      <p className="pl-hint">
        批量任务完成后在<a href="#/tasks">任务页</a>打开汇总卡片，点击任意成功行查看该目标 3D 结构
      </p>
    </main>
  )
}
