import { createElement as h, useEffect, useState } from 'react'
import { archivedServices, getServices, type PvServices, setServicesSession } from '../bff.ts'
import { getTask, subscribeTasks } from '../orchestrator.ts'
import { TASK_TYPE_LABEL, type TaskType } from '../prompts.ts'

const STATUS_BADGE: Record<string, string> = {
  running: '运行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

// A task that lives only in the surface archive (browser storage lost / daemon
// restarted / opened from another device). Everything the result page renders
// comes from the archive endpoints — fully interactive, no live session.
type ArchivedMeta = {
  taskId: string
  type?: TaskType
  title?: string
  meanPlddt?: number
  verdict?: string
  reportPath?: string
  pdbPath?: string
  accession?: string
  savedAt: string
}

async function fetchArchiveMeta(taskId: string, tries = 5): Promise<ArchivedMeta | null> {
  // The mount table flaps for a few seconds when the surface misses a health
  // probe (proxy answers 404 not_found mid-refresh) — so even a 404 gets
  // retried before we believe it; a false「任务不存在」reads as data loss.
  for (let i = 0; i < tries; i++) {
    try {
      const base = location.href.split('#')[0]
      const r = await fetch(new URL(`api/archive/${taskId}/meta`, base.endsWith('/') ? base : `${base}/`))
      if (r.ok) return (await r.json()) as unknown as ArchivedMeta
    } catch {
      /* transient — retry */
    }
    if (i < tries - 1) await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return null
}

// Archived pages hand the report to the pv toolview whose parseReport dispatch is
// keyed by toolName — batch reports carry jobs, search reports carry hits, so the
// archived type must map to the tool that produces that report shape.
function archivedToolName(type?: TaskType): string {
  if (type === 'complex') return 'predict_complex'
  if (type === 'batch') return 'batch_predict'
  if (type === 'search') return 'uniprot_search'
  if (type === 'compare') return 'compare_alphafold'
  return 'predict_structure'
}

// The workbench result page: the battle-tested protein-view toolview component
// (captured via the apply() shim) renders inside a clean platform stage. It
// self-serves report + structure + PAE through the BFF once we hand it the
// savedTo from the ledger.
export function ResultView({ taskId, cfg, sdk }: { taskId: string; cfg?: any; sdk?: any }) {
  const [, force] = useState(0)
  useEffect(() => subscribeTasks(() => force((n) => n + 1)), [])
  const task = getTask(taskId)
  // Not in localStorage (fresh browser / storage cleared) — try the archive.
  const [archived, setArchived] = useState<ArchivedMeta | null>(null)
  const [archivedChecked, setArchivedChecked] = useState(false)
  // Declared alongside the other top-level hooks: the !task branch renders this
  // only after archivedChecked flips, and a hook added between renders is React #310.
  const [archivedComparing, setArchivedComparing] = useState(false)
  useEffect(() => {
    if (task) return
    let alive = true
    setArchivedChecked(false)
    fetchArchiveMeta(taskId).then((m) => {
      if (alive) {
        setArchived(m)
        setArchivedChecked(true)
      }
    })
    return () => {
      alive = false
    }
  }, [taskId, task])

  useEffect(() => {
    setServicesSession(task?.sessionId ?? null)
    return () => setServicesSession(null)
  }, [task?.sessionId])

  if (!task) {
    if (!archivedChecked) return <main className="pl-result" />
    if (!archived || !archived.reportPath) {
      return (
        <main className="pl-result">
          <div className="pl-empty">
            任务不存在或已被清除 — 回<a href="#/">首页</a>
          </div>
        </main>
      )
    }
    // Compare entry on ARCHIVED single/complex pages: the old compare flow needed
    // the live task in localStorage, which stranded predictions opened from another
    // device / a cleared store. The archive carries accession + pdbPath, so the PDB
    // can be seeded into the fresh compare session straight from the archive API.
    const canCompareArchived =
      cfg && sdk && (archived.type ?? 'single') === 'single' && !!archived.accession && !!archived.pdbPath
    const runArchivedCompare = async () => {
      if (!cfg || !sdk || !archived?.pdbPath || archivedComparing) return
      setArchivedComparing(true)
      try {
        const pdb = (await archivedServices(taskId).call('protein.file', {
          path: archived.pdbPath,
        })) as { b64: string }
        const { runTask } = await import('../orchestrator.ts')
        await runTask(
          cfg,
          sdk,
          'compare',
          { accession: archived.accession, predictionPath: archived.pdbPath },
          { seedFiles: { [archived.pdbPath]: pdb.b64 } },
        )
        location.hash = '#/tasks'
      } catch (e) {
        console.warn('[platform] archived compare seed failed:', (e as Error)?.message)
      } finally {
        setArchivedComparing(false)
      }
    }
    return (
      <main className="pl-result">
        <div className="pl-result-head">
          <a className="pl-back" href="#/tasks">
            ← 任务
          </a>
          <span className="pl-badge done">已完成</span>
          <div>
            <div className="pl-result-title">{archived.title ?? archived.taskId}</div>
            <div className="pl-result-sub">
              {TASK_TYPE_LABEL[archived.type ?? 'single']} ·{' '}
              {new Date(archived.savedAt).toLocaleString('zh-CN')} · 历史归档
            </div>
          </div>
        </div>
        <ToolViewStage
          toolName={archivedToolName(archived.type)}
          savedTo={archived.reportPath}
          services={archivedServices(taskId)}
        />
        {canCompareArchived && (
          <div style={{ marginTop: 14, textAlign: 'center' }}>
            <button className="pl-back" onClick={() => void runArchivedCompare()} disabled={archivedComparing}>
              {archivedComparing ? '发起对比中…' : `⇄ 与 AlphaFold DB（${archived.accession}）对比 →`}
            </button>
          </div>
        )}
      </main>
    )
  }

  const running = task.status === 'running'
  const viewTool =
    task.type === 'complex'
      ? 'predict_complex'
      : task.type === 'batch'
        ? 'batch_predict'
        : task.type === 'search'
          ? 'uniprot_search'
          : task.type === 'compare'
            ? 'compare_alphafold'
            : 'predict_structure'
  // compare_alphafold(save_report:true) always lands at reports/<acc>.vs-alphafold.json,
  // but that key sits at the tail of a large result JSON — beyond the 4096-char
  // ledger clip — so the savedTo regex can miss it. Fall back to the deterministic path.
  const savedTo =
    task.type === 'compare' && task.input.accession
      ? (task.resultSavedTo ?? `reports/${task.input.accession.toUpperCase()}.vs-alphafold.json`)
      : task.resultSavedTo
  // 对比入口：单体任务按 accession 提交且已有预测 PDB 时，可一键与 AlphaFold DB 参考模型对比。
  const pdbPath = Object.values(task.savedTo).find((p) => p.endsWith('.pdb'))
  const canCompare =
    cfg && sdk && task.type === 'single' && task.status === 'done' && !!task.input.accession && !!pdbPath
  const [comparing, setComparing] = useState(false)
  const runCompare = async () => {
    if (!cfg || !sdk || comparing) return
    setComparing(true)
    try {
      // Tool calls resolve paths inside the CURRENT session's workspace — the
      // compare task runs in a fresh cwd, so seed the predicted PDB into it first.
      const pdb = (await getServices().call('protein.file', { path: pdbPath })) as { b64: string }
      const { runTask } = await import('../orchestrator.ts')
      await runTask(
        cfg,
        sdk,
        'compare',
        { accession: task.input.accession, predictionPath: pdbPath },
        {
          seedFiles: { [pdbPath!]: pdb.b64 },
        },
      )
    } catch (e) {
      console.warn('[platform] compare seed failed:', (e as Error)?.message)
    } finally {
      setComparing(false)
    }
  }

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
                  <span
                    style={{
                      fontSize: 14,
                      color: s.status === 'running' ? 'var(--pl-ink)' : 'var(--pl-muted)',
                    }}
                  >
                    {s.label}
                  </span>
                  {s.status === 'running' && (
                    <span className="pl-spinner" style={{ marginLeft: 'auto', width: 14, height: 14 }} />
                  )}
                  {s.status === 'done' && (
                    <span style={{ marginLeft: 'auto', color: 'var(--pl-ok)', fontSize: 13 }}>✓</span>
                  )}
                  {s.status === 'error' && (
                    <span style={{ marginLeft: 'auto', color: 'var(--pl-err)', fontSize: 13 }}>✕</span>
                  )}
                </div>
              ))
            )}
            {task.previewTail ? <div className="pl-runlog">{task.previewTail}</div> : null}
          </div>
        </div>
      )}

      {!running && task.type === 'batch' && task.resultJson && (
        <ToolViewStage
          toolName="batch_predict"
          savedTo="batch"
          preview={task.resultJson}
          services={getServices()}
        />
      )}
      {!running && task.type === 'complex' && task.resultJson && (
        <ToolViewStage
          toolName="predict_complex"
          savedTo="complex"
          preview={task.resultJson}
          services={getServices()}
        />
      )}
      {!running && task.type !== 'batch' && task.type !== 'complex' && savedTo && (
        <ToolViewStage toolName={viewTool} savedTo={savedTo} services={getServices()} />
      )}
      {canCompare && (
        <div style={{ marginTop: 14, textAlign: 'center' }}>
          <button className="pl-back" onClick={() => void runCompare()} disabled={comparing}>
            {comparing ? '发起对比中…' : `⇄ 与 AlphaFold DB（${task.input.accession}）对比 →`}
          </button>
        </div>
      )}
      {!running && task.type !== 'batch' && !savedTo && (
        <div className="pl-empty">
          没有可展示的结果{task.status === 'failed' ? '（任务未完成）' : ''} — 可回到<a href="#/">首页</a>
          重新提交
        </div>
      )}
    </main>
  )
}

function ToolViewStage({
  toolName,
  savedTo,
  services,
  preview,
}: {
  toolName: string
  savedTo: string
  services: PvServices
  preview?: string
}) {
  const [comp, setComp] = useState<any>(null)
  useEffect(() => {
    let alive = true
    // Capture the protein-view components bound to our BFF-backed services.
    import('../pv.ts').then(({ bindProteinToolViews, ownerProps }) => {
      if (!alive) return
      const map = bindProteinToolViews(services)
      setComp({ comp: map.get(toolName), props: ownerProps(toolName, savedTo, services, preview) })
    })
    return () => {
      alive = false
    }
  }, [toolName, savedTo, services])
  if (!comp?.comp) return <div className="pl-empty">加载视图组件…</div>
  return <div className="pl-stage-wrap">{h(comp.comp, comp.props)}</div>
}
