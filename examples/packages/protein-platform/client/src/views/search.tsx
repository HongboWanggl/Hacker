import { useState } from 'react'
import { runTask } from '../orchestrator.ts'

// UniProt 检索：uniprot_search → SearchCard（hits 列表）。检索产物 savedTo 走
// 与预测任务完全相同的 ledger 归约；结果页由 uniprot_search toolview 渲染。
// biome-ignore lint/suspicious/noExplicitAny: props are passed down from boot()'s untyped sdk handle and config cache
export function SearchView({ ready, cfg, sdk }: { ready: boolean; cfg: any; sdk: any }) {
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!ready || busy || !query.trim()) return
    setBusy(true)
    try {
      await runTask(cfg, sdk, 'search', { query: query.trim() })
      setQuery('')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="pl-page">
      <div className="pl-hero" style={{ padding: '12px 0 20px' }}>
        <h1>UniProt 检索</h1>
        <p>按蛋白名称 / 关键词检索 UniProt，结果卡片可直接查看 accession、物种与长度</p>
      </div>
      <div className="pl-composer" style={{ padding: 14 }}>
        <div className="pl-composer-foot">
          <input
            className="pl-input-name"
            style={{ flex: 1 }}
            placeholder="如：hemoglobin human / p53 / kinase SARS-CoV-2"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
          <button
            type="button"
            className="pl-submit"
            disabled={!ready || busy || !query.trim()}
            onClick={() => void submit()}
          >
            {busy ? '检索中…' : '检索 →'}
          </button>
        </div>
      </div>
      <p className="pl-hint">
        检索完成后到<a href="#/tasks">任务页</a>打开结果卡片；复制 accession 即可回首页发起预测
      </p>
    </main>
  )
}
