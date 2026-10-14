import { useCallback, useEffect, useMemo, useState } from 'react'
import { archivedServices, getServices, setServicesSession } from '../bff.ts'
import { ToolViewStage } from '../components/stage.tsx'
import { getTask, subscribeTasks } from '../orchestrator.ts'
import { MAX_BATCH_ACCESSIONS, TASK_TYPE_LABEL, type TaskType } from '../prompts.ts'
import { captureStageFigures, downloadShareReport, type StructureSet } from '../report.ts'

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
// biome-ignore lint/suspicious/noExplicitAny: props are passed down from boot()'s untyped sdk handle and config cache
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
  const [retrying, setRetrying] = useState(false)
  const [sharing, setSharing] = useState(false)
  // Cancel arm state for the running-stage block: first click asks, second
  // click (within 4s) aborts — same vocabulary as the task-list row.
  const [cancelArmed, setCancelArmed] = useState(false)

  // Shareable report: headline numbers live in the task's report JSON (shapes
  // differ per tool), the figures are the rendered stage canvases — snapshotted
  // inside the click handler while the WebGL frames are fresh.
  const shareReport = async (
    id: string,
    title: string,
    type: TaskType,
    savedAt: string | number,
    opts?: { savedTo?: string; resultJson?: string; archived?: boolean; structurePath?: string },
  ) => {
    if (sharing) return
    setSharing(true)
    try {
      // Figures first — but the stage mounts asynchronously (dynamic import +
      // structure fetch), so a click in that window must wait for the canvas
      // rather than capture nothing and call it an unrendered canvas.
      const figs = await captureStageFigures()
      // biome-ignore lint/suspicious/noExplicitAny: raw archived report payload, schema owned by the server
      let report: any
      try {
        if (opts?.resultJson) report = JSON.parse(opts.resultJson)
        else if (opts?.savedTo) report = await getServices().call('protein.report', { path: opts.savedTo })
        else if (opts?.archived) report = await archivedServices(id).call('protein.report', {})
      } catch {
        /* figures + header still make a useful report */
      }
      // Residue payload for the report's interactive 3D viewer — best-effort:
      // on failure the report degrades to the static PNG snapshots alone.
      let structure: unknown
      try {
        if (opts?.structurePath)
          structure = await getServices().call('protein.structure', { path: opts.structurePath })
        else if (opts?.archived) structure = await archivedServices(id).call('protein.structure', {})
      } catch {
        /* viewer omitted */
      }
      // Batch reports carry one PDB per job — fetch each (≤8) so the viewer
      // gets a per-target tab bar. All-or-nothing per target, never fatal.
      const jobs = Array.isArray(report?.jobs) ? (report.jobs as any[]) : [] // biome-ignore lint/suspicious/noExplicitAny: same archived payload, see above
      const okJobs = jobs.filter(
        (j) => j?.status === 'ok' && typeof j?.savedTo === 'string' && j.savedTo.endsWith('.pdb'),
      )
      let structures: StructureSet[] | undefined
      if (okJobs.length > 0) {
        const fetched = await Promise.all(
          okJobs.slice(0, 8).map(async (j) => {
            try {
              const st = (
                opts?.archived
                  ? await archivedServices(id).call('protein.structure', { path: j.savedTo })
                  : await getServices().call('protein.structure', { path: j.savedTo })
              ) as StructureSet
              return {
                name: typeof j.accession === 'string' ? j.accession : (j.name ?? ''),
                meanPlddt: typeof j.meanPlddt === 'number' ? j.meanPlddt : undefined,
                ...st,
              }
            } catch {
              return null
            }
          }),
        )
        const ok = fetched.filter((s): s is NonNullable<typeof s> => !!s && (s.residues?.length ?? 0) > 0)
        if (ok.length > 0) structures = ok
      }
      const mean =
        typeof report?.meanPlddt === 'number'
          ? report.meanPlddt
          : typeof report?.summary?.meanPlddt === 'number'
            ? report.summary.meanPlddt
            : typeof report?.prediction?.meanPlddt === 'number'
              ? report.prediction.meanPlddt
              : undefined
      const verdict =
        report?.verdict ??
        report?.compared?.verdict ??
        (report?.summary?.ok != null ? `${report.summary.ok}/${report.summary.total} 目标成功` : undefined)
      downloadShareReport({
        taskId: id,
        title,
        typeLabel: TASK_TYPE_LABEL[type] ?? type,
        savedAt,
        meanPlddt: mean,
        verdict,
        report,
        figs,
        // Say why, truthfully: a UniProt search task never had a structure view
        // to snapshot, which is not the same as a canvas that failed to render.
        ...(figs.length > 0
          ? {}
          : {
              figureNote:
                type === 'search'
                  ? '本任务为 UniProt 检索，产物是候选列表（见下方 JSON），没有结构图'
                  : '本次未能捕获结构图快照（结构视图未就绪）；下方「完整报告数据」与评分不受影响',
            }),
        ...(structures ? { structures } : structure ? { structure } : {}),
      })
    } finally {
      setSharing(false)
    }
  }
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

  // SearchCard hand-off: 检索结果 → 一键预测（单个 = 单体任务，多个 = 批量任务）。
  // Defined before the archived branch so archived search pages get it too.
  // useCallback matters: ToolViewStage remounts the whole pv stage (fresh 3D
  // canvas) whenever its effect deps change identity, so every prop handed to
  // it must be render-stable.
  const handlePredict = useCallback(
    (accs: string[]) => {
      if (!cfg || !sdk || accs.length === 0) return
      // batch_predict rejects more than 8 accessions outright, so an over-long
      // selection used to start a task that could only fail. Cap it here — the same
      // number the batch tab and the candidate panel use.
      const picked = accs.slice(0, MAX_BATCH_ACCESSIONS)
      void (async () => {
        try {
          const { runTask } = await import('../orchestrator.ts')
          if (picked.length === 1) await runTask(cfg, sdk, 'single', { accession: picked[0] })
          else await runTask(cfg, sdk, 'batch', { accessions: picked })
          location.hash = '#/tasks'
        } catch (e) {
          console.warn('[platform] predict hand-off failed:', (e as Error)?.message)
        }
      })()
    },
    [cfg, sdk],
  )
  // Same identity rule: archivedServices(taskId) built fresh each render would
  // remount the archived stage on every store tick. Building it for live tasks
  // too is harmless — the closure is never invoked there.
  const archivedSvc = useMemo(() => archivedServices(taskId), [taskId])

  // BatchCard drill-down hand-off: one target of a batch run → AlphaFold DB
  // compare. The job's PDB is fetched through whichever services back the stage
  // (live session or archive shim) and seeded into the fresh compare session.
  // Same identity rule as handlePredict (stage remount on unstable props).
  const makeBatchCompare =
    (fetchFile: (path: string) => Promise<{ b64: string }>) =>
    async (job: { accession: string; savedTo?: string }) => {
      if (!cfg || !sdk || !job.savedTo) return
      try {
        const base = job.savedTo.split('/').pop() ?? job.savedTo
        const pdb = await fetchFile(job.savedTo)
        const { runTask } = await import('../orchestrator.ts')
        await runTask(
          cfg,
          sdk,
          'compare',
          { accession: job.accession, predictionPath: base },
          { seedFiles: { [base]: pdb.b64 } },
        )
        location.hash = '#/tasks'
      } catch (e) {
        console.warn('[platform] batch compare seed failed:', (e as Error)?.message)
      }
    }
  const runBatchCompare = useCallback(
    (job: { accession: string; savedTo?: string }) => {
      void makeBatchCompare((path) => getServices().call('protein.file', { path }) as never)(job)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cfg, sdk],
  )
  const runArchivedBatchCompare = useCallback(
    (job: { accession: string; savedTo?: string }) => {
      void makeBatchCompare((path) => archivedSvc.call('protein.file', { path }) as never)(job)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cfg, sdk, archivedSvc],
  )

  if (!task) {
    if (!archivedChecked) return <main className="pl-result" />
    if (!archived?.reportPath) {
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
        {archived.type === 'search' && <SearchNextStep />}
        <ToolViewStage
          toolName={archivedToolName(archived.type)}
          savedTo={archived.reportPath}
          services={archivedSvc}
          onPredict={handlePredict}
          onCompare={archived.type === 'batch' ? runArchivedBatchCompare : undefined}
        />
        {canCompareArchived && (
          <div style={{ marginTop: 14, textAlign: 'center' }}>
            <button
              type="button"
              className="pl-back"
              onClick={() => void runArchivedCompare()}
              disabled={archivedComparing}
            >
              {archivedComparing ? '发起对比中…' : `⇄ 与 AlphaFold DB（${archived.accession}）对比 →`}
            </button>
          </div>
        )}
        {archived && (
          <div style={{ marginTop: 14, textAlign: 'center' }}>
            <button
              type="button"
              className="pl-back"
              disabled={sharing}
              onClick={() =>
                void shareReport(
                  taskId,
                  archived.title ?? archived.taskId,
                  archived.type ?? 'single',
                  archived.savedAt,
                  {
                    archived: true,
                  },
                )
              }
            >
              {sharing ? '生成报告中…' : '⇩ 分享报告（HTML）'}
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
          seedFiles: { [pdbPath as string]: pdb.b64 },
        },
      )
    } catch (e) {
      console.warn('[platform] compare seed failed:', (e as Error)?.message)
    } finally {
      setComparing(false)
    }
  }
  // Cancel a running task from the result page: same two-click arm as the task
  // list. cancelTask aborts the session's prompt; the orchestrator settles the
  // task to 已取消 and (being a user cancel) never auto-retries it.
  const cancelRunning = () => {
    if (!running) return
    if (!cancelArmed) {
      setCancelArmed(true)
      setTimeout(() => setCancelArmed(false), 4000)
      return
    }
    setCancelArmed(false)
    void import('../orchestrator.ts').then(({ cancelTask }) => cancelTask(task.id))
  }

  // One-click resubmit of a failed task (transient gateway stalls are the usual
  // cause — the stall watchdog already retried once internally). The stored input
  // is exactly what the views passed to runTask, so replay is verbatim; compare
  // additionally needs its PDB re-seeded from the (still-registered) session.
  const retryTask = async () => {
    if (!cfg || !sdk || retrying) return
    setRetrying(true)
    try {
      const { runTask } = await import('../orchestrator.ts')
      if (task.type === 'compare' && task.input.predictionPath) {
        const pdb = (await getServices().call('protein.file', { path: task.input.predictionPath })) as {
          b64: string
        }
        await runTask(cfg, sdk, 'compare', task.input, {
          seedFiles: { [task.input.predictionPath]: pdb.b64 },
        })
      } else {
        await runTask(cfg, sdk, task.type, task.input)
      }
      location.hash = '#/tasks'
    } catch (e) {
      console.warn('[platform] retry failed:', (e as Error)?.message)
    } finally {
      setRetrying(false)
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

      {(task.status === 'failed' || task.status === 'cancelled') && (
        <div style={{ marginTop: 14, textAlign: 'center' }}>
          <button type="button" className="pl-back" disabled={retrying} onClick={() => void retryTask()}>
            {retrying ? '重新提交中…' : '↻ 重新提交此任务'}
          </button>
        </div>
      )}

      {running && (
        <div className="pl-stage-wrap">
          <div style={{ padding: '28px 20px' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 12,
              }}
            >
              <div className="pl-taskrow-title">正在运行 · 阶段进度</div>
              <button
                type="button"
                className={`pl-row-del${cancelArmed ? ' armed' : ''}`}
                onClick={cancelRunning}
                title="取消任务"
              >
                {cancelArmed ? '确认取消' : '取消'}
              </button>
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
          onPredict={handlePredict}
          onCompare={runBatchCompare}
        />
      )}
      {!running && task.type === 'complex' && task.resultJson && (
        <ToolViewStage
          toolName="predict_complex"
          savedTo="complex"
          preview={task.resultJson}
          services={getServices()}
          onPredict={handlePredict}
        />
      )}
      {!running && task.type === 'search' && <SearchNextStep />}
      {!running && task.type !== 'batch' && task.type !== 'complex' && (savedTo || task.resultJson) && (
        <ToolViewStage
          toolName={viewTool}
          savedTo={savedTo ?? 'inline'}
          // No on-disk report (agent skipped analyze_confidence): the inline
          // predict_structure result IS the report — hand it over parseable and
          // the panel renders structure + metrics without a re-fetch.
          preview={savedTo ? undefined : task.resultJson}
          services={getServices()}
          onPredict={handlePredict}
        />
      )}
      {canCompare && (
        <div style={{ marginTop: 14, textAlign: 'center' }}>
          <button type="button" className="pl-back" onClick={() => void runCompare()} disabled={comparing}>
            {comparing ? '发起对比中…' : `⇄ 与 AlphaFold DB（${task.input.accession}）对比 →`}
          </button>
        </div>
      )}
      {!running && (
        <div style={{ marginTop: 14, textAlign: 'center' }}>
          <button
            type="button"
            className="pl-back"
            disabled={sharing}
            onClick={() =>
              void shareReport(task.id, task.title, task.type, task.createdAt, {
                savedTo,
                resultJson: task.resultJson,
                // Live residue fetch for the interactive viewer (any task that
                // produced a PDB — single/complex; batch has per-target PDBs).
                structurePath: Object.values(task.savedTo).find((p) => p.endsWith('.pdb')),
              })
            }
          >
            {sharing ? '生成报告中…' : '⇩ 分享报告（HTML）'}
          </button>
        </div>
      )}
      {!running && task.type !== 'batch' && !savedTo && !task.resultJson && (
        <div className="pl-empty">
          没有可展示的结果{task.status === 'failed' || task.status === 'cancelled' ? '（任务未完成）' : ''} —
          可回到<a href="#/">首页</a>
          重新提交
        </div>
      )}
    </main>
  )
}

// A description routed to 检索 is not the answer, it is the shortlist: the
// prediction happens when the user picks one. Say so above the table — without
// it the candidate list reads as "the platform gave me nothing". Shared by the
// live and the archived branch: the archived branch is what a history card
// (or a cleared localStorage) opens, and it was the one users kept landing on.
function SearchNextStep() {
  return (
    <div className="pl-callout" style={{ marginTop: 14 }}>
      这是候选列表（描述型输入的第一步）：点表格每行末尾的 <b>▶</b> 预测该条目，得到结构 + 置信度报告；
      也可点行首复制 accession，回<a href="#/">首页</a>预测，或用勾选框批量预测多个。
    </div>
  )
}
