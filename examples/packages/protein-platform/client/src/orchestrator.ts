import { bffCall } from './bff.ts'
import { buildPrompt, STAGE_LABEL, TASK_TYPE_LABEL, type TaskInput, type TaskType } from './prompts.ts'

// Task = one agent session. Progress is a ledger reduction: tool/call opens a
// stage, tool/result closes it (savedTo captured), turn/end finishes the task.
// Everything renders from this store — the user never sees a chat.

export type Stage = { tool: string; label: string; status: 'running' | 'done' | 'error'; savedTo?: string }

export type Task = {
  id: string
  sessionId?: string
  type: TaskType
  title: string
  input: TaskInput
  status: 'running' | 'done' | 'failed' | 'cancelled'
  stages: Stage[]
  /** last toolUseId -> savedTo, for the result page */
  savedTo: Record<string, string>
  /** main result savedTo (confidence report JSON) once known */
  resultSavedTo?: string
  /** set once the completed task has been persisted to the surface archive */
  archived?: boolean
  /** Full inline result JSON for tools whose report only lives in the ledger —
   *  batch_predict ({jobs,summary}, BatchCard) and predict_complex (report.savedTo
   *  is the PDB itself, so no report file exists to re-fetch). */
  resultJson?: string
  previewTail?: string
  createdAt: number
  updatedAt: number
  error?: string
}

const LS_KEY = 'pp-tasks-v1'
const listeners = new Set<() => void>()
let tasks: Task[] = load()

function load(): Task[] {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as Task[]
  } catch {
    return []
  }
}

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(tasks))
  } catch {
    /* quota — best effort */
  }
}

function emit() {
  persist()
  for (const l of listeners) l()
}

export function subscribeTasks(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getTasks(): Task[] {
  return tasks
}

export function getTask(id: string): Task | undefined {
  return tasks.find((t) => t.id === id)
}

function patch(id: string, fn: (t: Task) => void) {
  const t = tasks.find((x) => x.id === id)
  if (!t) return
  fn(t)
  t.updatedAt = Date.now()
  emit()
}

export function defaultTitle(type: TaskType, input: TaskInput): string {
  if (type === 'compare') return `对比：${input.accession ?? '?'} vs AlphaFold`
  if (type === 'batch' && input.accessions?.length) {
    const shown = input.accessions.slice(0, 2).join(' · ')
    return `批量：${shown}${input.accessions.length > 2 ? ` 等 ${input.accessions.length} 个` : ''}`
  }
  if (input.query) return `检索：${input.query}`
  if (input.accession) return input.accession
  if (input.name) return input.name
  if (input.sequence) return `自定义序列 · ${input.sequence.trim().length} aa`
  return TASK_TYPE_LABEL[type]
}

export type RunHandle = { cancel: () => void }

const VERDICT_ZH: Array<[number, string]> = [
  [90, '高置信结构'],
  [70, '骨架可靠 · 局部待验证'],
  [50, '置信偏低 · 谨慎解读'],
]
function verdictOf(mean: number): string {
  for (const [floor, label] of VERDICT_ZH) if (mean >= floor) return label
  return '低置信 · 大概率含无序区'
}

// Persist a completed task into the surface archive (report JSON + PDB) so the
// history survives browser storage loss and daemon restarts — the BFF needs a
// live session in the daemon registry, the archive does not. Best-effort: a
// failed write logs and leaves the task unarchived (retryable by re-render).
async function archiveTask(id: string): Promise<void> {
  const t = getTask(id)
  if (!t?.sessionId) return
  const b64of = (s: string) => btoa(unescape(encodeURIComponent(s)))
  const post = async (files: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const base = location.href.split('#')[0]
    const r = await fetch(new URL('api/archive', base.endsWith('/') ? base : `${base}/`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        taskId: id,
        sessionId: t!.sessionId,
        type: t!.type,
        title: t!.title,
        reportPath: 'report.json',
        ...extra,
        files,
      }),
    })
    if (!r.ok) throw new Error(`archive: HTTP ${r.status}`)
    patch(id, (t2) => {
      t2.archived = true
    })
  }
  try {
    if (t.type === 'batch') {
      // No on-disk summary: the inline ledger result IS the report. Persist it
      // plus each successful target's PDB (budget-capped — the server rejects
      // archives beyond 2 MiB) so the archived page can render rows in 3D.
      if (!t.resultJson) return
      const parsed = JSON.parse(t.resultJson) as {
        summary?: { total?: number; ok?: number; meanPlddt?: number }
        jobs?: Array<{ status?: string; savedTo?: string }>
      }
      const files: Record<string, string> = { 'report.json': b64of(t.resultJson) }
      const jobPdbs: string[] = []
      let totalBytes = 0
      for (const j of parsed.jobs ?? []) {
        if (j.status !== 'ok' || typeof j.savedTo !== 'string') continue
        try {
          const f = (await bffCall(t.sessionId, 'protein.file', { path: j.savedTo })) as { b64: string }
          const bytes = Math.floor((f.b64.length * 3) / 4)
          if (totalBytes + bytes > 1_400_000) break
          totalBytes += bytes
          const base = j.savedTo.split('/').pop()!
          files[`pdb-${base}`] = f.b64
          jobPdbs.push(base)
        } catch {
          /* one missing PDB degrades that row only */
        }
      }
      const mean = typeof parsed.summary?.meanPlddt === 'number' ? parsed.summary.meanPlddt : undefined
      await post(files, {
        ...(mean !== undefined ? { meanPlddt: mean } : {}),
        ...(jobPdbs.length > 0 ? { jobPdbs } : {}),
        verdict: `${parsed.summary?.ok ?? '?'}/${parsed.summary?.total ?? '?'} 目标成功`,
      })
      return
    }
    if (t.type === 'search') {
      // The hits report is a workspace file — archive it verbatim for offline
      // SearchCard re-renders.
      if (!t.resultSavedTo) return
      const report = await bffCall(t.sessionId, 'protein.report', { path: t.resultSavedTo })
      await post({ 'report.json': b64of(JSON.stringify(report)) })
      return
    }
    if (t.type === 'compare') {
      // Compare reports live on disk ({compared, prediction, alphafold} shape);
      // also persist both models so the archived Compare3D overlay works: the
      // prediction as model.pdb (default /structure target) and the AlphaFold
      // reference as pdb-<basename> (deep-linked via its savedTo path).
      const reportPath =
        t.resultSavedTo ??
        (t.input.accession ? `reports/${t.input.accession.toUpperCase()}.vs-alphafold.json` : undefined)
      if (!reportPath) return
      const report = (await bffCall(t.sessionId, 'protein.report', { path: reportPath })) as {
        compared?: { verdict?: string }
        prediction?: { path?: string; meanPlddt?: number }
        alphafold?: { savedTo?: string }
      }
      const files: Record<string, string> = { 'report.json': b64of(JSON.stringify(report)) }
      if (typeof report.prediction?.path === 'string') {
        try {
          const pdb = (await bffCall(t.sessionId, 'protein.file', { path: report.prediction.path })) as {
            b64: string
          }
          files['model.pdb'] = pdb.b64
        } catch {
          /* overlay degrades to metrics-only */
        }
      }
      if (typeof report.alphafold?.savedTo === 'string') {
        try {
          const ref = (await bffCall(t.sessionId, 'protein.file', { path: report.alphafold.savedTo })) as {
            b64: string
          }
          files[`pdb-${report.alphafold.savedTo.split('/').pop()}`] = ref.b64
        } catch {
          /* overlay degrades to metrics-only */
        }
      }
      await post(files, {
        ...(typeof report.prediction?.meanPlddt === 'number'
          ? { meanPlddt: report.prediction.meanPlddt }
          : {}),
        ...(report.compared?.verdict ? { verdict: report.compared.verdict } : {}),
        ...(typeof report.prediction?.path === 'string' ? { pdbPath: report.prediction.path } : {}),
      })
      return
    }

    // single / complex: confidence report + model PDB (+ optional PAE matrix).
    let report: { file?: string; savedTo?: string; meanPlddt?: number; paePath?: string }
    let reportJson: string
    if (t.type === 'complex') {
      if (!t.resultJson) return
      reportJson = t.resultJson
      report = JSON.parse(reportJson)
    } else {
      if (!t.resultSavedTo) return
      report = (await bffCall(t.sessionId, 'protein.report', { path: t.resultSavedTo })) as typeof report
      reportJson = JSON.stringify(report)
    }
    const pdbPath =
      (typeof report.file === 'string' && report.file.endsWith('.pdb') ? report.file : undefined) ??
      (typeof report.savedTo === 'string' && report.savedTo.endsWith('.pdb') ? report.savedTo : undefined) ??
      Object.values(t.savedTo).find((p) => p.endsWith('.pdb'))
    if (!pdbPath) throw new Error('no PDB path in report')
    const pdb = (await bffCall(t.sessionId, 'protein.file', { path: pdbPath })) as { b64: string }
    const files: Record<string, string> = { 'report.json': b64of(reportJson), 'model.pdb': pdb.b64 }
    // Persist the PAE heatmap alongside the model when the report carries one —
    // the quantized matrix is tiny and lets the archived page render the full panel.
    if (report.paePath) {
      try {
        const pae = await bffCall(t.sessionId, 'protein.pae', { path: report.paePath })
        files['pae.json'] = b64of(JSON.stringify(pae))
      } catch {
        /* heatmap is optional — archive without it */
      }
    }
    let mean = typeof report.meanPlddt === 'number' ? report.meanPlddt : undefined
    // Complex reports carry ipTM-family scores but no mean pLDDT. The archived
    // PDB has it in the B-factor column (already normalized to 0-100 by the
    // shared parser) — one extra read fills the wall card's score slot.
    if (mean === undefined) {
      try {
        const st = (await bffCall(t.sessionId, 'protein.structure', { path: pdbPath })) as {
          residues?: Array<{ b?: number }>
        }
        const bs = (st.residues ?? []).map((r) => r.b).filter((v): v is number => Number.isFinite(v))
        if (bs.length > 0) mean = Math.round((bs.reduce((s, v) => s + v, 0) / bs.length) * 10) / 10
      } catch {
        /* score chip stays empty — archive proceeds */
      }
    }
    await post(files, {
      ...(mean !== undefined ? { meanPlddt: mean, verdict: verdictOf(mean) } : {}),
      pdbPath,
      ...(t.input.accession ? { accession: t.input.accession } : {}),
    })
  } catch (e) {
    console.warn('[platform] archive write failed:', (e as Error)?.message)
  }
}

// Drives one task end-to-end. The browser cannot mkdir, so the surface server
// creates the task dir, we register it as a workspace, then open the session.
export async function runTask(
  cfg: { tasksRoot: string },
  sdk: any,
  type: TaskType,
  input: TaskInput,
  opts?: { seedFiles?: Record<string, string> }, // relPath -> b64, written into the fresh workspace
): Promise<RunHandle> {
  const id = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const task: Task = {
    id,
    type,
    title: defaultTitle(type, input),
    input,
    status: 'running',
    stages: [],
    savedTo: {},
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  tasks = [task, ...tasks]
  emit()

  const controller = new AbortController()
  const attempt = async (): Promise<void> => {
    // Stall watchdog: the model gateway occasionally hangs an inference without a
    // transport error, so neither turn/end nor the events-loop catch ever fires and
    // the task spins in "running" forever. Any ledger event or preview delta counts
    // as life; silence past STALL_MS aborts the session and the retry below resubmits.
    // Boltz runs emit NO events for their whole duration — the watchdog must outlive
    // the tool's own timeout (predict_complex 1300s / batch 900s in the preset), or it
    // kills perfectly healthy predictions mid-flight.
    const STALL_MS = type === 'complex' || type === 'batch' ? 1_400_000 : 180_000
    let lastActivity = Date.now()
    let stalled = false
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > STALL_MS) {
        stalled = true
        clearInterval(watchdog)
        controller.abort()
      }
    }, 30_000)
    try {
      const base = location.href.split('#')[0]
      const r = await fetch(new URL('api/task', base.endsWith('/') ? base : `${base}/`), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: id, ...(opts?.seedFiles ? { files: opts.seedFiles } : {}) }),
      })
      if (!r.ok) throw new Error(`task dir: HTTP ${r.status}`)
      const cwd = `${cfg.tasksRoot}/${id}`
      await sdk.workspace.add(cwd)
      const session = await sdk.session.new({ cwd, preset: 'standard' })
      patch(id, (t) => {
        t.sessionId = session.id
      })

      session.onPermissionRequest((req: any) => {
        // Defense-in-depth consent: platform prompts are read-only science
        // pipelines; answer allow so a non-chat UI never dead-ends. The profile
        // approvals.mode remains the primary gate.
        const options = req?.options ?? req?.payload?.options ?? []
        const allow = options.find((o: any) => /allow|proceed|approve/i.test(o?.kind ?? o?.optionId ?? ''))
        if (allow)
          void session
            .answer({
              requestId: req.requestId ?? req.id,
              response: { optionId: allow.optionId ?? allow.kind },
            })
            .catch(() => {})
      })

      void (async () => {
        try {
          for await (const row of session.events({ preview: true })) {
            lastActivity = Date.now()
            const env = (row as { event?: unknown })?.event ?? row
            // Ledger envelopes carry their payload in `data` ({toolUseId,name,args} /
            // {toolUseId,isError,content} / {reason,error?}); tolerate flat rows too.
            const ev = ((env as { data?: Record<string, unknown> }).data ?? env) as {
              name?: string
              args?: unknown
              toolUseId?: string
              isError?: boolean
              content?: { text?: string }[]
              reason?: string
              error?: { message?: string }
            }
            const kind = (env as { type?: string; kind?: string })?.type ?? (env as { kind?: string })?.kind
            if (kind === 'tool/call') {
              patch(id, (t) => {
                const existing = t.stages.find((s) => s.tool === ev.name && s.status === 'running')
                if (!existing)
                  t.stages.push({
                    tool: ev.name!,
                    label: STAGE_LABEL[ev.name!] ?? ev.name!,
                    status: 'running',
                  })
              })
            } else if (kind === 'tool/result') {
              const text = typeof ev?.content?.[0]?.text === 'string' ? ev.content[0].text : ''
              // batch_predict has no on-disk summary and predict_complex's report
              // carries no JSON savedTo (its savedTo IS the PDB): in both cases the
              // result IS the report. Keep it verbatim so the result page can feed
              // the pv components a parseable resultPreview directly. Complex runs
              // in two shapes — API mode carries predictionId, local boltz carries
              // engine:"boltz2-local" — match either.
              if (
                text.startsWith('{') &&
                (text.includes('"jobs"') ||
                  text.includes('"predictionId"') ||
                  text.includes('"boltz2-local"'))
              ) {
                patch(id, (t) => {
                  t.resultJson = text.slice(0, 32_000)
                })
              }
              // Artifact paths appear under either key ("savedTo" on fetch/predict outputs,
              // "file" inside the confidence report body), and report previews interleave
              // line-number prefixes — the path itself is always a plain quoted string.
              const paths = [
                ...text.matchAll(/"(?:savedTo|file|pdbPath|reportPath)"\s*:\s*"((?:[^"\\]|\\.)*)"/g),
              ].map((m) => m[1].replace(/\\(.)/g, '$1'))
              const savedTo = paths.find((p) => /\.(pdb|fasta|json)$/.test(p))
              const confidence = paths.find((p) => /confidence\.json$/.test(p))
              patch(id, (t) => {
                const st = [...t.stages].reverse().find((s) => s.status === 'running')
                if (st) st.status = ev.isError ? 'error' : 'done'
                if (!ev.isError) {
                  if (savedTo) t.savedTo[ev.toolUseId ?? st?.tool ?? '?'] = savedTo
                  // The result page renders the confidence report; prefer it over any
                  // earlier JSON (e.g. a fetch record) that happens to land first.
                  if (confidence) t.resultSavedTo = confidence
                  else if (savedTo?.endsWith('.json') && !savedTo.endsWith('.pdb') && !t.resultSavedTo)
                    t.resultSavedTo = savedTo
                }
              })
            } else if (kind === 'turn/end') {
              patch(id, (t) => {
                if (ev.reason === 'completed') t.status = 'done'
                else if (t.status === 'running') {
                  t.status = 'failed'
                  t.error = ev.error?.message ?? `turn ${ev.reason}`
                }
              })
              if (ev.reason === 'completed') void archiveTask(id)
              return
            }
          }
        } catch (e) {
          // Event stream died without a turn/end (transport close, session loss). A running
          // task must not hang forever — surface the failure instead of swallowing it.
          patch(id, (t) => {
            if (t.status === 'running') {
              t.status = 'failed'
              t.error = `事件流中断：${(e as Error)?.message ?? 'session ended'}`
            }
          })
        }
      })()

      let tail = ''
      let tailTimer: ReturnType<typeof setTimeout> | null = null
      session.onPreview((p: any) => {
        if (typeof p?.delta === 'string') {
          lastActivity = Date.now()
          tail = (tail + p.delta).slice(-400)
          if (!tailTimer) {
            tailTimer = setTimeout(() => {
              tailTimer = null
              patch(id, (t) => {
                t.previewTail = tail
              })
            }, 400)
          }
        }
      })

      await session.prompt(buildPrompt(type, input), { signal: controller.signal })
      patch(id, (t) => {
        if (t.status === 'running') t.status = 'done'
      })
    } catch (e: any) {
      patch(id, (t) => {
        if (t.status === 'running') {
          t.status = /abort/i.test(String(e?.name ?? e)) && !stalled ? 'cancelled' : 'failed'
          t.error = stalled
            ? `STALL_WATCHDOG：超过 ${(STALL_MS / 1000) | 0}s 无任何事件，会话已中止重试`
            : String(e?.message ?? e).slice(0, 300)
        }
      })
    } finally {
      clearInterval(watchdog)
    }
  }

  void (async () => {
    await attempt()
    // The model gateway intermittently drops large agent rounds (TRANSPORT, no status).
    // One fresh-session retry turns that from a failed task into a slower success.
    await new Promise((r) => setTimeout(r, 3000))
    const t = getTask(id)
    if (
      t?.status === 'failed' &&
      /STALL_WATCHDOG|TRANSPORT|TURN_ERROR|turn (abort|blocked)|status=\?|事件流中断|ECONN|EAI_AGAIN|socket hang up|fetch failed|reset/i.test(
        t.error ?? '',
      )
    ) {
      patch(id, (t2) => {
        t2.status = 'running'
        t2.error = undefined
        t2.stages = []
        t2.savedTo = {}
        t2.resultSavedTo = undefined
        t2.resultJson = undefined
        t2.previewTail = ''
      })
      await attempt()
    }
  })()

  return {
    cancel: () => {
      controller.abort()
    },
  }
}
