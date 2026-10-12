import { type MouseEvent, useEffect, useState } from 'react'
import { type ArchiveMeta, listArchive } from '../bff.ts'
import { StructureThumb } from '../components/thumb.tsx'
import { getTasks, subscribeTasks } from '../orchestrator.ts'
import { TASK_TYPE_LABEL, type TaskType } from '../prompts.ts'

const STATUS_BADGE: Record<string, string> = {
  running: '运行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

// History rows from the surface archive: tasks completed on this machine whose
// record outlived this browser's localStorage (or another device's tasks).
function ArchivedRow({ m, onDeleted }: { m: ArchiveMeta; onDeleted: (taskId: string) => void }) {
  const [confirming, setConfirming] = useState(false)
  const hasStructure = m.type === 'single' || m.type === 'complex' || m.type === 'compare'
  const remove = async (e: MouseEvent) => {
    // Two-click confirm: the first click arms the row's ✕ into a red 确认 for
    // 4s — no modal, no accidental wipes, and the whole row stays a link.
    e.preventDefault()
    e.stopPropagation()
    if (!confirming) {
      setConfirming(true)
      setTimeout(() => setConfirming(false), 4000)
      return
    }
    try {
      const base = location.href.split('#')[0]
      const r = await fetch(new URL(`api/archive/${m.taskId}`, base.endsWith('/') ? base : `${base}/`), {
        method: 'DELETE',
      })
      if (r.ok) onDeleted(m.taskId)
    } catch {
      /* row stays — the user can retry */
    }
  }
  return (
    <a className="pl-taskrow" href={`#/task/${m.taskId}`}>
      {hasStructure ? (
        <StructureThumb taskId={m.taskId} small />
      ) : (
        <span className="pl-badge done">已完成</span>
      )}
      <div className="pl-taskrow-main">
        <div className="pl-taskrow-title">{m.title ?? m.taskId}</div>
        <div className="pl-taskrow-meta">
          {TASK_TYPE_LABEL[(m.type as TaskType) ?? 'single']} · {new Date(m.savedAt).toLocaleString('zh-CN')}{' '}
          · 历史归档
        </div>
      </div>
      {typeof m.meanPlddt === 'number' && (
        <div className="pl-taskrow-score">
          <span className="pl-taskrow-num">{m.meanPlddt.toFixed(1)}</span>
          <span className="pl-taskrow-unit">pLDDT</span>
        </div>
      )}
      <button className={`pl-row-del${confirming ? ' armed' : ''}`} onClick={remove} title="删除归档">
        {confirming ? '确认删除' : '✕'}
      </button>
    </a>
  )
}

export function TasksView() {
  const [, force] = useState(0)
  useEffect(() => subscribeTasks(() => force((n) => n + 1)), [])
  const tasks = getTasks()
  const [archived, setArchived] = useState<ArchiveMeta[] | null>(null)
  useEffect(() => {
    let alive = true
    listArchive().then((list) => {
      if (alive) setArchived(list)
    })
    return () => {
      alive = false
    }
  }, [])
  const liveIds = new Set(tasks.map((t) => t.id))
  const history = (archived ?? []).filter((m) => !liveIds.has(m.taskId))
  const empty = tasks.length === 0 && history.length === 0
  return (
    <main className="pl-page">
      <div className="pl-wall-title">
        全部任务 <small>· {tasks.length + history.length}</small>
      </div>
      {empty ? (
        <div className="pl-empty">
          还没有任务 — 回<a href="#/">首页</a>提交第一个预测
        </div>
      ) : (
        <div className="pl-tasklist">
          {tasks.map((t) => (
            <a key={t.id} className="pl-taskrow" href={`#/task/${t.id}`}>
              <span className={`pl-badge ${t.status}`}>{STATUS_BADGE[t.status] ?? t.status}</span>
              <div className="pl-taskrow-main">
                <div className="pl-taskrow-title">{t.title}</div>
                <div className="pl-taskrow-meta">
                  {TASK_TYPE_LABEL[t.type]} · {new Date(t.createdAt).toLocaleString('zh-CN')}
                  {t.error ? ` · ${t.error.slice(0, 60)}` : ''}
                </div>
              </div>
              <div className="pl-stages">
                {t.stages.map((s, i) => (
                  <span key={i} className={`pl-stage-dot ${s.status}`} title={`${s.label} · ${s.status}`} />
                ))}
              </div>
            </a>
          ))}
          {history.map((m) => (
            <ArchivedRow
              key={m.taskId}
              m={m}
              onDeleted={(id) => setArchived((list) => (list ?? []).filter((x) => x.taskId !== id))}
            />
          ))}
        </div>
      )}
    </main>
  )
}
