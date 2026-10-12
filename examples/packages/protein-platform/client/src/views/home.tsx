import { useEffect, useState } from 'react'
import { type ArchiveMeta, getServices, listArchive } from '../bff.ts'
import { StructureThumb } from '../components/thumb.tsx'
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

// History card from the surface archive (task not in this browser's localStorage).
// Meta carries the headline score, so no fetch is needed — except the Cα thumbnail,
// which lazily pulls the archived structure and turns the card into a mini figure.
function ArchiveCard({ m }: { m: ArchiveMeta }) {
  // compare archives store the prediction as model.pdb — the trace thumb works.
  const hasStructure = m.type === 'single' || m.type === 'complex' || m.type === 'compare'
  // Batch cards show up to three per-target mini traces instead of one figure —
  // an at-a-glance quality read across the whole run.
  const batchJobs = m.type === 'batch' ? (m.jobPdbs ?? []).slice(0, 3) : []
  return (
    <a className="pl-card pl-card-fig" href={`#/task/${m.taskId}`}>
      {hasStructure && <StructureThumb taskId={m.taskId} />}
      {batchJobs.length > 0 && (
        <div className="pl-thumb-grid">
          {batchJobs.map((p) => (
            <figure key={p} className="pl-thumb-cell">
              <StructureThumb taskId={m.taskId} path={p} small />
              <figcaption>{p.split('_')[0].replace(/\.pdb$/, '')}</figcaption>
            </figure>
          ))}
        </div>
      )}
      <div className="pl-card-top">
        <span className="pl-card-type">{TASK_TYPE_LABEL[(m.type as TaskType) ?? 'single']}</span>
      </div>
      <div className="pl-card-title">{m.title ?? m.taskId}</div>
      <div className="pl-card-sub">{new Date(m.savedAt).toLocaleDateString('zh-CN')} · 历史归档</div>
      {typeof m.meanPlddt === 'number' ? (
        <>
          <div className="pl-card-metric" style={{ marginTop: 'auto' }}>
            <span className="pl-card-score">{m.meanPlddt.toFixed(1)}</span>
            <span className="pl-card-score-label">平均 pLDDT</span>
          </div>
          {m.verdict ? <div className="pl-card-verdict">{m.verdict}</div> : null}
        </>
      ) : (
        // Scoreless types still have a story: batch carries 「N/N 目标成功」,
        // search/compare fall back to the neutral prompt.
        <div className="pl-card-verdict">{m.verdict ?? '已完成 · 点击查看'}</div>
      )}
    </a>
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
  const [ligand, setLigand] = useState('')
  const [busy, setBusy] = useState(false)
  // One-time consent explainer: what the automated session will (and won't) do.
  const [consent, setConsent] = useState<boolean>(() => {
    try {
      return localStorage.getItem('pp-consent-v1') === '1'
    } catch {
      return true // storage unavailable — don't nag
    }
  })
  const tasks = getTasks()
  const latest = tasks[0]
  // History from the surface archive (tasks completed elsewhere / storage lost).
  const [archived, setArchived] = useState<ArchiveMeta[]>([])
  useEffect(() => {
    let alive = true
    listArchive().then((list) => {
      if (alive) setArchived(list)
    })
    return () => {
      alive = false
    }
  }, [])

  const submit = async () => {
    if (!ready || busy) return
    const trimmed = text.trim()
    if (!trimmed) return
    setBusy(true)
    try {
      if (type === 'complex') {
        // One chain per line, in A/B/C… order; ligand SMILES optional.
        const seqs = trimmed
          .split('\n')
          .map((l) =>
            l
              .replace(/^>.*$/, '')
              .replace(/[^A-Za-z]/g, '')
              .toUpperCase(),
          )
          .filter((s) => s.length >= 5)
        if (seqs.length === 0) return
        await runTask(cfg, sdk, 'complex', {
          sequences: seqs,
          ...(ligand.trim() ? { ligandSmiles: ligand.trim() } : {}),
          ...(name.trim() ? { name: name.trim() } : {}),
        })
        setText('')
        setLigand('')
        setName('')
        return
      }
      if (type === 'batch') {
        const accs = trimmed
          .split(/[\n,;\s]+/)
          .filter((s) => /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9])$/i.test(s))
        if (accs.length === 0) return
        await runTask(cfg, sdk, 'batch', { accessions: accs.slice(0, 8).map((a) => a.toUpperCase()) })
        setText('')
        setName('')
        return
      }
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
        !isSequence &&
        /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9])(?:-\d+)?$/i.test(
          trimmed.replace(/\s/g, ''),
        )
      const input = isFasta
        ? {
            sequence: seqOnly,
            name: name.trim() || trimmed.split('\n')[0].slice(1).split('|')[0].trim() || undefined,
          }
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
          placeholder={
            type === 'complex'
              ? '每行一条链序列（按 A、B、C… 顺序），如：\nMVLSPADKTNVKAAWGKVGAHAGEYGAEAL\nVHLTPEEKSAVTALWGKVNVDEVGGEALGR\n（可另填配体 SMILES）'
              : type === 'batch'
                ? '每行一个 UniProt ID（≤8 个）：\nP69905\nP68871\nP04637'
                : '粘贴氨基酸序列（如 MKTAYIAKQRQISFVK…）\n或输入 UniProt ID（如 P04637）\n或直接粘贴 FASTA'
          }
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void submit()
          }}
        />
        <div className="pl-composer-foot">
          <div className="pl-type-tabs">
            {(['single', 'complex', 'batch'] as TaskType[]).map((t) => (
              <button key={t} className={`pl-type-tab ${type === t ? 'on' : ''}`} onClick={() => setType(t)}>
                {TASK_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
          {type === 'complex' && (
            <input
              className="pl-input-name"
              placeholder="配体 SMILES（可选）"
              value={ligand}
              onChange={(e) => setLigand(e.target.value)}
            />
          )}
          <input
            className="pl-input-name"
            placeholder="名称（可选）"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className="pl-submit"
            disabled={
              !ready ||
              busy ||
              !text.trim() ||
              (type === 'complex' &&
                text.split('\n').filter((l) => l.replace(/[^A-Za-z]/g, '').length >= 5).length === 0) ||
              (type === 'batch' &&
                text
                  .split(/[\n,;\s]+/)
                  .filter((s) =>
                    /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9])$/i.test(s.trim()),
                  ).length === 0)
            }
            onClick={() => void submit()}
          >
            {busy ? '提交中…' : '开始预测 →'}
          </button>
        </div>
      </div>
      <p className="pl-hint">
        {type === 'complex' ? (
          <>复合物模式：每行一条链（≥2 条效果最佳），Boltz-2 联合预测界面与配体结合</>
        ) : type === 'batch' ? (
          <>批量模式：最多 8 个 UniProt ID 逐个预测，完成后汇总质量分布卡片</>
        ) : (
          <>
            支持 <code>FASTA</code> · <code>UniProt ID</code> · <code>原始序列</code>，⌘/Ctrl + Enter 快速提交
          </>
        )}
      </p>

      {!consent && (
        <div className="pl-consent" role="note">
          <div>
            <strong>提交后会发生什么？</strong> 平台为每个任务启动一个独立的自动化会话，按需调用只读科学工具
            （UniProt 检索 · 结构预测 · 置信度分析 · AlphaFold 对比）。工具仅访问该任务的独立工作区，
            不会触碰你的其他文件；全程无需审批，完成即在报告墙出结果。
          </div>
          <button
            className="pl-consent-ok"
            onClick={() => {
              try {
                localStorage.setItem('pp-consent-v1', '1')
              } catch {
                /* private mode — dismiss for this visit only */
              }
              setConsent(true)
            }}
          >
            知道了
          </button>
        </div>
      )}

      {(tasks.length > 0 || archived.length > 0) && (
        <>
          <div className="pl-wall-title">
            最近预测 <small>· {tasks.length + archived.length} 个任务</small>
          </div>
          <div className="pl-wall">
            {tasks.slice(0, 12).map((t) => (
              <TaskCard key={t.id} task={t} />
            ))}
            {archived
              .filter((m) => !tasks.some((t) => t.id === m.taskId))
              .slice(0, Math.max(0, 12 - Math.min(tasks.length, 12)))
              .map((m) => (
                <ArchiveCard key={m.taskId} m={m} />
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
