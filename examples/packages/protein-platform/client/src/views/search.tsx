import { useState } from 'react'
import { CandidatePanel, useCandidates } from '../components/candidates.tsx'

// UniProt 检索：与首页描述框走完全相同的候选面板（lookup.ts）——本页不再产生
// 「检索任务」，因此也不会留下一条没有预览图、点开只有候选表的历史归档。
// biome-ignore lint/suspicious/noExplicitAny: props are passed down from boot()'s untyped sdk handle and config cache
export function SearchView({ ready, cfg, sdk }: { ready: boolean; cfg: any; sdk: any }) {
  const [query, setQuery] = useState('')
  const cand = useCandidates(cfg, sdk)
  const submit = () => {
    if (!ready || !query.trim()) return
    cand.start(query)
  }
  return (
    <main className="pl-page">
      <div className="pl-hero" style={{ padding: '12px 0 20px' }}>
        <h1>UniProt 检索</h1>
        <p>按蛋白名称 / 关键词检索 UniProt，候选表可直接查看 accession、物种与长度</p>
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
              if (e.key === 'Enter') submit()
            }}
          />
          <button type="button" className="pl-submit" disabled={!ready || !query.trim()} onClick={submit}>
            检索 →
          </button>
        </div>
      </div>
      <CandidatePanel state={cand.state} onClose={cand.reset} cfg={cfg} sdk={sdk} />
      <p className="pl-hint">
        点候选行尾 <b>▶</b> 或勾选后批量预测，任务会出现在<a href="#/tasks">任务页</a>；检索本身不留记录
      </p>
    </main>
  )
}
