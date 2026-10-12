import { useEffect, useState } from 'react'
import { getTasks, subscribeTasks } from '../orchestrator.ts'
import { TASK_TYPE_LABEL } from '../prompts.ts'

const STATUS_BADGE: Record<string, string> = {
  running: '运行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export function TasksView() {
  const [, force] = useState(0)
  useEffect(() => subscribeTasks(() => force((n) => n + 1)), [])
  const tasks = getTasks()
  return (
    <main className="pl-page">
      <div className="pl-wall-title">
        全部任务 <small>· {tasks.length}</small>
      </div>
      {tasks.length === 0 ? (
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
        </div>
      )}
    </main>
  )
}
