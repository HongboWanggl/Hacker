import { type MouseEvent, useEffect, useState } from 'react'
import { type ArchiveMeta, listArchive } from '../bff.ts'
import { StructureThumb } from '../components/thumb.tsx'
import { cancelTask, clearFailedTasks, getTasks, subscribeTasks, type Task } from '../orchestrator.ts'
import { TASK_TYPE_LABEL, type TaskType } from '../prompts.ts'

const STATUS_BADGE: Record<string, string> = {
  running: '运行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

// History rows from the surface archive: tasks completed on this machine whose
// record outlived this browser's localStorage (or another device's tasks).
function ArchivedRow({
  m,
  canDelete,
  onDeleted,
}: {
  m: ArchiveMeta
  canDelete: boolean
  onDeleted: (taskId: string) => void
}) {
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
        <StructureThumb taskId={m.taskId} small meta={m} />
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
      {canDelete && (
        <button
          type="button"
          className={`pl-row-del${confirming ? ' armed' : ''}`}
          onClick={remove}
          title="删除归档"
        >
          {confirming ? '确认删除' : '✕'}
        </button>
      )}
    </a>
  )
}

// Live rows need the same in-row-action pattern as ArchivedRow (a button inside
// the row link), so they get a component too. Cancel arms like delete: the first
// click turns 取消 into a red 确认 for 4s — aborting a multi-minute prediction on
// a stray click would be worse than one extra tap.
function LiveRow({ t }: { t: Task }) {
  const [confirming, setConfirming] = useState(false)
  const cancel = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!confirming) {
      setConfirming(true)
      setTimeout(() => setConfirming(false), 4000)
      return
    }
    cancelTask(t.id)
  }
  return (
    <a className="pl-taskrow" href={`#/task/${t.id}`}>
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
      {t.status === 'running' && (
        <button
          type="button"
          className={`pl-row-del${confirming ? ' armed' : ''}`}
          onClick={cancel}
          title="取消任务"
        >
          {confirming ? '确认取消' : '取消'}
        </button>
      )}
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
  // Filter row: as the archive grows past a screenful, type chips + a title
  // search are the only sane way back to "that run from last week".
  const [filter, setFilter] = useState<'all' | TaskType>('all')
  const [q, setQ] = useState('')
  const liveIds = new Set(tasks.map((t) => t.id))
  const history = (archived ?? []).filter((m) => !liveIds.has(m.taskId))
  const ql = q.trim().toLowerCase()
  const match = (hay: string) => !ql || hay.toLowerCase().includes(ql)
  const liveF = tasks.filter((t) => (filter === 'all' || t.type === filter) && match(`${t.title} ${t.id}`))
  const historyF = history.filter(
    (m) =>
      (filter === 'all' || (m.type ?? 'single') === filter) &&
      match(`${m.title ?? ''} ${m.taskId} ${m.accession ?? ''} ${m.verdict ?? ''}`),
  )
  // Render window: the archive grows unboundedly, so the list shows the newest
  // PAGE history rows behind a 加载更多 expander. Filters/search/counts still
  // operate on the FULL pool — only the DOM is windowed (the server list is a
  // few dozen meta.json reads with write-back enrichment; the render cost was
  // the part that would not scale).
  const PAGE = 30
  const [shown, setShown] = useState(PAGE)
  useEffect(() => {
    setShown(PAGE)
  }, [filter, q])
  const total = tasks.length + history.length
  // `archived === null` means the history fetch is still in flight — showing the
  // empty state here flashes "还没有任务" on every visit before the list lands.
  const loaded = archived !== null
  const empty = loaded && total === 0
  // Non-owner visitors (guest/testers behind the login gate) get no delete
  // affordance — and the server 403s the call regardless; submission stays open
  // to every role. Local dev (no forwarding header) defaults to owner.
  const [canDelete, setCanDelete] = useState(true)
  useEffect(() => {
    let alive = true
    fetch(new URL('api/whoami', location.href.split('#')[0]))
      .then((r) => r.json())
      .then((w) => {
        if (alive) setCanDelete(!w.readOnly)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  // Failed/cancelled rows are this browser's own scratch (archives only hold
  // completed tasks), so "clear failed" is a local tidy-up with the same
  // two-click arming as the archive ✕ — no modal, no accidental wipes.
  const [clearArmed, setClearArmed] = useState(false)
  const failCount = tasks.filter((t) => t.status === 'failed' || t.status === 'cancelled').length
  const clearFailed = () => {
    if (!clearArmed) {
      setClearArmed(true)
      setTimeout(() => setClearArmed(false), 4000)
      return
    }
    setClearArmed(false)
    clearFailedTasks()
  }
  const types: Array<'all' | TaskType> = ['all', 'single', 'complex', 'batch', 'search', 'compare']
  const countFor = (k: 'all' | TaskType) =>
    k === 'all'
      ? total
      : tasks.filter((t) => t.type === k).length + history.filter((m) => (m.type ?? 'single') === k).length
  return (
    <main className="pl-page">
      <div className="pl-wall-title">
        全部任务{' '}
        <small>· {ql || filter !== 'all' ? `${liveF.length + historyF.length} / ${total}` : total}</small>
        {failCount > 0 && (
          <button
            type="button"
            className={`pl-row-del pl-clear-failed${clearArmed ? ' armed' : ''}`}
            onClick={clearFailed}
            title="清除本机浏览器里的失败/取消记录（服务器归档的已完成任务不受影响）"
          >
            {clearArmed ? '确认清除' : `清除失败记录 ×${failCount}`}
          </button>
        )}
      </div>
      {!loaded ? (
        <div className="pl-empty">正在加载历史归档…</div>
      ) : empty ? (
        <div className="pl-empty">
          还没有任务 — 回<a href="#/">首页</a>提交第一个预测
        </div>
      ) : (
        <>
          <div className="pl-filters">
            {types.map((k) => (
              <button
                type="button"
                key={k}
                className={`pl-type-tab ${filter === k ? 'on' : ''}`}
                onClick={() => setFilter(k)}
              >
                {k === 'all' ? '全部' : TASK_TYPE_LABEL[k]}
                <em>{countFor(k)}</em>
              </button>
            ))}
            <input
              className="pl-input-name pl-search"
              placeholder="搜索标题 / ID…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {(liveF.length > 0 || historyF.length > 0) && (
            <div className="pl-tasklist">
              {liveF.map((t) => (
                <LiveRow key={t.id} t={t} />
              ))}
              {historyF.slice(0, shown).map((m) => (
                <ArchivedRow
                  key={m.taskId}
                  m={m}
                  canDelete={canDelete}
                  onDeleted={(id) => setArchived((list) => (list ?? []).filter((x) => x.taskId !== id))}
                />
              ))}
            </div>
          )}
          {historyF.length > shown && (
            <button type="button" className="pl-more" onClick={() => setShown((n) => n + PAGE)}>
              加载更多 · 还有 {historyF.length - shown} 条
            </button>
          )}
          {liveF.length === 0 && historyF.length === 0 && (
            <div className="pl-empty">没有匹配的任务 — 换个关键词或类型试试</div>
          )}
        </>
      )}
    </main>
  )
}
