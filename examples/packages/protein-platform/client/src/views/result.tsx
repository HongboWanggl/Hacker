import { createElement as h, useEffect, useState } from 'react'
import { getServices, setServicesSession } from '../bff.ts'
import { getTask, subscribeTasks } from '../orchestrator.ts'
import { TASK_TYPE_LABEL } from '../prompts.ts'

const STATUS_BADGE: Record<string, string> = {
  running: '运行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

// The workbench result page: the battle-tested protein-view toolview component
// (captured via the apply() shim) renders inside a clean platform stage. It
// self-serves report + structure + PAE through the BFF once we hand it the
// savedTo from the ledger.
export function ResultView({ taskId }: { taskId: string }) {
  const [, force] = useState(0)
  useEffect(() => subscribeTasks(() => force((n) => n + 1)), [])
  const task = getTask(taskId)

  useEffect(() => {
    setServicesSession(task?.sessionId ?? null)
    return () => setServicesSession(null)
  }, [task?.sessionId])

  if (!task) {
    return (
      <main className="pl-result">
        <div className="pl-empty">任务不存在或已被清除 — 回<a href="#/">首页</a></div>
      </main>
    )
  }

  const running = task.status === 'running'
  const viewTool =
    task.type === 'complex' ? 'predict_complex' : 'predict_structure'
  const savedTo = task.resultSavedTo

  return (
    <main className="pl-result">
      <div className="pl-result-head">
        <a className="pl-back" href="#/tasks">
          ← 任务
        </a>
        <span className={`pl-badge ${task.status}`}>{STATUS_BADGE[task.status] ?? task.status}</span>
        <div>
          <div className="pl-result-title">{task.title}</div>
          <div className="pl-result-sub">
            {TASK_TYPE_LABEL[task.type]} · {new Date(task.createdAt).toLocaleString('zh-CN')}
          </div>
        </div>
      </div>

      {task.error && <div className="pl-error-banner">{task.error}</div>}

      {running && (
        <div className="pl-stage-wrap">
          <div style={{ padding: '28px 20px' }}>
            <div className="pl-taskrow-title" style={{ marginBottom: 12 }}>
              正在运行 · 阶段进度
            </div>
            {task.stages.length === 0 ? (
              <div className="pl-card-verdict">正在启动 agent…</div>
            ) : (
              task.stages.map((s, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
                  <span className={`pl-stage-dot ${s.status}`} />
                  <span style={{ fontSize: 14, color: s.status === 'running' ? 'var(--pl-ink)' : 'var(--pl-muted)' }}>
                    {s.label}
                  </span>
                  {s.status === 'running' && <span className="pl-spinner" style={{ marginLeft: 'auto', width: 14, height: 14 }} />}
                  {s.status === 'done' && <span style={{ marginLeft: 'auto', color: 'var(--pl-ok)', fontSize: 13 }}>✓</span>}
                  {s.status === 'error' && <span style={{ marginLeft: 'auto', color: 'var(--pl-err)', fontSize: 13 }}>✕</span>}
                </div>
              ))
            )}
            {task.previewTail ? <div className="pl-runlog">{task.previewTail}</div> : null}
          </div>
        </div>
      )}

      {!running && savedTo && <ToolViewStage toolName={viewTool} savedTo={savedTo} />}
      {!running && !savedTo && (
        <div className="pl-empty">没有可展示的结果{task.status === 'failed' ? '（任务未完成）' : ''} — 可回到<a href="#/">首页</a>重新提交</div>
      )}
    </main>
  )
}

function ToolViewStage({ toolName, savedTo }: { toolName: string; savedTo: string }) {
  const [comp, setComp] = useState<any>(null)
  useEffect(() => {
    let alive = true
    // Capture the protein-view components bound to our BFF-backed services.
    import('../pv.ts').then(({ bindProteinToolViews, ownerProps }) => {
      if (!alive) return
      const map = bindProteinToolViews(getServices())
      setComp({ comp: map.get(toolName), props: ownerProps(toolName, savedTo, getServices()) })
    })
    return () => {
      alive = false
    }
  }, [toolName, savedTo])
  if (!comp?.comp) return <div className="pl-empty">加载视图组件…</div>
  return (
    <div className="pl-stage-wrap">
      {h(comp.comp, comp.props)}
    </div>
  )
}
