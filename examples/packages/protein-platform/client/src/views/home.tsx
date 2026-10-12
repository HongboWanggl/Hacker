import { useEffect, useState } from 'react'
import { getServices } from '../bff.ts'
import { getTasks, runTask, subscribeTasks } from '../orchestrator.ts'
import { TASK_TYPE_LABEL, type TaskType } from '../prompts.ts'

const runningStage = (t: { stages: Array<{ label: string; status: string }> }) =>
  t.stages.find((s) => s.status === 'running')?.label

// Lazy wall snapshot: fetches the confidence report via the BFF and renders
// name + mean pLDDT + band bar + verdict. Fails soft (title-only card).
function ReportSnapshot({ task }: { task: any }) {
  const [snap, setSnap] = useState<any>(null)
  useEffect(() => {
    let alive = true
    if (!task.resultSavedTo || !task.sessionId) return
    getServices()
      .call('protein.report', { path: task.resultSavedTo })
      .then((report: any) => {
        if (alive) setSnap(report)
      })
      .catch(() => {
        /* archived/dead session: card stays minimal */
      })
    return () => {
      alive = false
    }
  }, [task.resultSavedTo, task.sessionId])
  const bands = snap?.bands
  const mean = snap?.meanPlddt
  return (
    <>
      <div className="pl-card-title">{snap?.name ?? task.title}</div>
      <div className="pl-card-sub">
        {snap?.residues ? `${snap.residues} aa · ` : ''}
        {new Date(task.createdAt).toLocaleDateString('zh-CN')}
      </div>
      {bands ? (
        <>
          <div className="pl-bandbar">
            {(['veryHigh_gt90', 'confident_70_90', 'low_50_70', 'veryLow_lt50'] as const).map((k, i) => (
              <div key={k} className={`pl-band b${i + 1}`} style={{ width: `${bands[k]?.pct ?? 0}%` }} />
            ))}
          </div>
          <div className="pl-card-metric">
            <span className="pl-card-score">{typeof mean === 'number' ? mean.toFixed(1) : '—'}</span>
            <span className="pl-card-score-label">平均 pLDDT</span>
          </div>
          {snap?.verdict ? <div className="pl-card-verdict">{snap.verdict}</div> : null}
        </>
      ) : (
        <div className="pl-card-verdict">
          {task.status === 'failed'
            ? (task.error ?? '任务失败')
            : task.status === 'done'
              ? '已完成 · 点击查看'
              : task.status === 'cancelled'
                ? '已取消'
                : '…'}
        </div>
      )}
    </>
  )
}

function TaskCard({ task }: { task: any }) {
  const running = task.status === 'running'
  return (
    <a className="pl-card" href={`#/task/${task.id}`}>
      <div className="pl-card-top">
        <span className="pl-card-type">{TASK_TYPE_LABEL[task.type]}</span>
        {running && <span className="pl-spinner" />}
      </div>
      {running ? (
        <div className="pl-card-running">
          <div>
            <div className="pl-card-title">{task.title}</div>
            <div className="pl-stage-mini">{runningStage(task) ?? '正在启动…'}</div>
          </div>
        </div>
      ) : (
        <ReportSnapshot task={task} />
      )}
    </a>
  )
}

export function HomeView({ ready, cfg, sdk }: { ready: boolean; cfg: any; sdk: any }) {
  const [, force] = useState(0)
  useEffect(() => subscribeTasks(() => force((n) => n + 1)), [])
  const [type, setType] = useState<TaskType>('single')
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const tasks = getTasks()
  const latest = tasks[0]

  const submit = async () => {
    if (!ready || busy) return
    const trimmed = text.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      const letters = trimmed.replace(/[^A-Za-z]/g, '')
      const isFasta = trimmed.startsWith('>')
      const isSequence = !isFasta && letters.length >= 10 && /^[A-Za-z\s\n-]+$/.test(trimmed)
      const seqOnly = isFasta
        ? trimmed
            .split('\n')
            .filter((l) => !l.startsWith('>'))
            .join('')
            .replace(/\s/g, '')
            .toUpperCase()
        : null
      const isAccession =
        !isSequence && /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9])(?:-\d+)?$/i.test(trimmed.replace(/\s/g, ''))
      const input = isFasta
        ? { sequence: seqOnly, name: name.trim() || trimmed.split('\n')[0].slice(1).split('|')[0].trim() || undefined }
        : isAccession
          ? { accession: trimmed.toUpperCase(), name: name.trim() || trimmed.toUpperCase() }
          : isSequence
            ? { sequence: letters.toUpperCase(), name: name.trim() || undefined }
            : { accession: trimmed, name: name.trim() || undefined } // let uniprot_fetch validate
      await runTask(cfg, sdk, type, input)
      setText('')
      setName('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="pl-home">
      <div className="pl-hero">
        <h1>蛋白质结构预测，从此只需粘贴</h1>
        <p>输入氨基酸序列或 UniProt ID，几分钟内得到带置信度的三维结构与完整分析报告</p>
      </div>
      <div className="pl-composer">
        <textarea
          placeholder={'粘贴氨基酸序列（如 MKTAYIAKQRQISFVK…）\n或输入 UniProt ID（如 P04637）\n或直接粘贴 FASTA'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit()
          }}
        />
        <div className="pl-composer-foot">
          <div className="pl-type-tabs">
            {(['single', 'complex', 'batch'] as TaskType[]).map((t) => (
              <button
                key={t}
                className={`pl-type-tab ${type === t ? 'on' : ''}`}
                onClick={() => setType(t)}
                title={t === 'single' ? undefined : '即将上线'}
                disabled={t !== 'single'}
              >
                {TASK_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
          <input className="pl-input-name" placeholder="名称（可选）" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="pl-submit" disabled={!ready || busy || !text.trim()} onClick={() => void submit()}>
            {busy ? '提交中…' : '开始预测 →'}
          </button>
        </div>
      </div>
      <p className="pl-hint">
        支持 <code>FASTA</code> · <code>UniProt ID</code> · <code>原始序列</code>，⌘/Ctrl + Enter 快速提交 · 复合物与批量模式即将开放
      </p>

      {tasks.length > 0 && (
        <>
          <div className="pl-wall-title">
            最近预测 <small>· {tasks.length} 个任务</small>
          </div>
          <div className="pl-wall">
            {tasks.slice(0, 12).map((t) => (
              <TaskCard key={t.id} task={t} />
            ))}
          </div>
        </>
      )}
      {latest?.status === 'running' && (
        <div style={{ marginTop: 18, textAlign: 'center' }}>
          <a className="pl-back" href={`#/task/${latest.id}`}>
            查看运行进度 →
          </a>
        </div>
      )}
    </main>
  )
}
