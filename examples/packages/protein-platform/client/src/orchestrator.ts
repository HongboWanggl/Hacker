import type { DaemonLink } from './agnes.ts'
import { buildPrompt, STAGE_LABEL, TASK_TYPE_LABEL, type TaskInput, type TaskType } from './prompts.ts'
import { shouldRetryAttempt } from './transient.ts'

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
  /** last errored tool result (truncated) — a completed turn with zero
   *  artifacts and a recorded error is a FAILED task, not a fake done. Used for
   *  the retry judgement, where any transient symptom should count. */
  lastError?: string
  /** FIRST errored tool result: the CAUSE. In an agent pipeline the earliest
   *  failure is what broke the plan and the later ones are its consequences, so
   *  this — not lastError — is what the user is shown. The 2944-aa Q02388 run is
   *  the example: the cause was `Sequence too long (2944 residues); … ceiling for
   *  predict_complex`, but the newest error was a downstream
   *  `Cannot read structures/Q02388.pdb` for a file that was never written. */
  rootError?: string
  /** The error of the LAST fold tool that failed, when there was one. Preferred
   *  over rootError, because "first" and "the one that explains the failure" are
   *  not the same error when an early failure was a ROUTING signal rather than
   *  the cause: the 920-aa P10275 run failed ESMFold with HTTP 413, switched to
   *  predict_complex exactly as told, and then lost the fold to worker memory —
   *  so the first error is a step the agent handled and the last fold error is
   *  why the user has no structure. A fold tool beats rootError; a non-fold tool
   *  (uniprot_fetch, analyze_confidence) never displaces one. */
  foldError?: string
  /** toolUseId → tool name. `tool/result` rows carry no name, so the attribution
   *  above needs the `tool/call` that opened them. */
  toolNames?: Record<string, string>
}

/** The tools whose whole job is producing the structure. A failure here is the
 *  answer to "why is there no model"; a failure anywhere else is a step. */
const FOLD_TOOLS = new Set(['predict_structure', 'predict_complex', 'batch_predict'])

const LS_KEY = 'pp-tasks-v1'
const listeners = new Set<() => void>()
let tasks: Task[] = load()

/** Did this task produce its PRODUCT — not merely any file?
 *
 *  A task whose fold failed still has `sequences/<acc>.fasta` in savedTo from
 *  the fetch step, so "savedTo is non-empty" is NOT evidence of success. That
 *  false positive is how the 2026-10-15 Q02388 run (2944 aa COL7A1: ESMFold
 *  refused, the Boltz tier sat in the MSA step until the 20-min cap) settled as
 *  已完成 with nothing behind it and could never auto-retry. The tests below
 *  ask for the deliverable itself: a structure, or the report that stands in
 *  for one on the paths that have no PDB of their own. */
export function hasProductArtifact(t: Task): boolean {
  // complex (API mode) and batch report inline — there is no file to check.
  if (t.resultJson) return true
  const paths = [...Object.values(t.savedTo), t.resultSavedTo].filter((p): p is string => !!p)
  // compare/search deliver a report; their PDB (predicted or reference) is not
  // the point of the task.
  if (t.type === 'compare' || t.type === 'search') return paths.some((p) => /\.json$/.test(p))
  return paths.some((p) => /\.pdb$/i.test(p))
}

/** What the platform answers when the daemon asks for approval.
 *
 *  Mirrors the SDK's PermissionOutcome structurally instead of importing it —
 *  the surface bundle has no business pulling the SDK in for a shape that only
 *  ever crosses the wire as JSON. `allowed-permanent` is deliberately absent:
 *  PermissionGate.answer only resolves allowed-once/allowed-session/rejected, so
 *  a permanent verdict would silently fall back to **reject**. */
export type ApprovalOutcome = { optionId: string } | { verdict: 'rejected' }

/** Pick the permission option that says "go ahead".
 *
 *  THROWS NOTHING AND MUST NOT: until 2026-10-15 this handler called
 *  `session.answer(...)`, which does not exist on the SDK Session, so every
 *  prompt raised a TypeError and PermissionGate.answer swallowed it and fell
 *  back to rejectPermission — i.e. the platform auto-rejected every approval it
 *  was ever asked for (12/12 rows in the VPS ledger, `user_rejected`, `via:
 *  sync`). The agent was refused `predict_structure` on a ~200-aa domain split
 *  even though those tools are `requiresApproval: "never"`, so long chains
 *  dead-ended as `turn blocked`, and the ui1 run "hallucinating" a user refusal
 *  was in fact reporting the truth. The handler's RETURN VALUE is the answer. */
export function permissionOutcome(req: { options?: unknown } | undefined | null): ApprovalOutcome {
  const options = (Array.isArray(req?.options) ? req.options : []).filter(
    (o): o is { optionId: string; kind?: string } =>
      !!o && typeof (o as { optionId?: unknown }).optionId === 'string',
  )
  const byKind = (k: string) => options.find((o) => o.kind === k)
  const pick =
    byKind('allow_once') ??
    byKind('allow_always') ??
    options.find((o) => /allow|proceed|approv|^yes$/i.test(o.optionId))
  return pick ? { optionId: pick.optionId } : { verdict: 'rejected' }
}

/** One approval request, in the words the wall can show.
 *
 *  A task that dies on a refused approval used to read `turn blocked`, which
 *  names neither the tool nor the fact that the platform was the one saying no.
 *  Recovering the tool label is what makes that reason actionable. */
export function describeApproval(
  req: { toolCall?: Record<string, unknown> } | undefined | null,
  options: readonly { optionId?: string; name?: string }[],
  outcome: ApprovalOutcome,
): string {
  const tc = req?.toolCall ?? {}
  const label = ['title', 'name', 'toolName', 'kind', 'toolCallId']
    .map((k) => tc[k])
    .find((v): v is string => typeof v === 'string' && v.length > 0)
  const picked = 'optionId' in outcome ? options.find((o) => o.optionId === outcome.optionId) : undefined
  return `${label ?? '未知工具'} → ${picked?.name ?? ('optionId' in outcome ? outcome.optionId : '拒绝')}`
}

/** The reason a non-completed turn shows the user.
 *
 *  Two defects met here. `blocked` rendered as the literal string `turn blocked`
 *  — no tool, no cause, and no hint that the platform itself had refused.
 *  And the stall watchdog's actionable text was clobbered: the watchdog aborts
 *  the controller, the turn ends first with the transport's own
 *  `This operation was aborted`, and the catch block's `status === 'running'`
 *  guard then skipped the STALL_WATCHDOG message entirely — which also killed
 *  the auto-retry, since isTransientError keys on that marker (the raw abort
 *  text matches nothing in TRANSIENT_RE). Both now resolve here, and the
 *  caller has already excluded user cancellations.
 *
 *  A third defect sat one step downstream and outlived this fix: the marker did
 *  earn a retry, but the retry gate demanded an un-aborted signal — and the
 *  watchdog aborts. So the stall reason was honest and the resubmit still never
 *  happened. See shouldRetryAttempt() in transient.ts. */
export function turnFailureReason(
  ev: { reason?: string; error?: { message?: string } },
  ctx: { approvals?: readonly string[]; stallMs?: number } = {},
): string {
  if (ev.reason === 'blocked') {
    const last = ctx.approvals?.at(-1)
    return last
      ? `回合被中断：审批请求未获平台放行（${last}）。请重试，仍失败请反馈。`
      : '回合被中断：审批请求未获平台放行，且平台未记录到请求内容。请重试，仍失败请反馈。'
  }
  const msg = ev.error?.message
  if (ev.reason === 'aborted' || /abort/i.test(msg ?? ''))
    return `STALL_WATCHDOG：超过 ${Math.round((ctx.stallMs ?? 180_000) / 1000)}s 无任何事件，会话已中止重试`
  return msg ?? `回合 ${ev.reason} 结束（无进一步信息）`
}

function load(): Task[] {
  try {
    const rows = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as Task[]
    // Migrate records written under the old "savedTo non-empty" rule: a green ✓
    // over an empty 3D slot is worse than an honest failure, and those rows are
    // already in the user's browser — a code fix alone would never reach them.
    for (const t of rows) {
      if (t.status === 'done' && !hasProductArtifact(t)) {
        t.status = 'failed'
        t.error = t.lastError ?? '未产出结构（当时被误判为已完成）'
      }
    }
    return rows
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

/** Drop this browser's failed/cancelled task rows. The server archive only ever
 *  holds completed tasks, so these rows are local scratch — clearing them is a
 *  view tidy-up, never an evidence change (archived runs are untouched). */
export function clearFailedTasks(): number {
  const before = tasks.length
  tasks = tasks.filter((t) => t.status !== 'failed' && t.status !== 'cancelled')
  const removed = before - tasks.length
  if (removed > 0) emit()
  return removed
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
  // A description handed to the prediction tabs is a prediction — only the 检索
  // task is actually a search, and titling both 「检索：…」 read as if the platform
  // had ignored the request to predict.
  if (input.query) return type === 'search' ? `检索：${input.query}` : input.query
  if (input.accession) return input.accession
  if (input.name) return input.name
  if (input.sequence) return `自定义序列 · ${input.sequence.trim().length} aa`
  return TASK_TYPE_LABEL[type]
}

export type RunHandle = { cancel: () => void }

// Live run controls by task id — cancelTask works from any view without the
// caller having to keep the RunHandle around (rows in the task list, the
// result page header). A hung gateway turn is exactly when nobody has it.
const runners = new Map<string, () => void>()

/** Abort a running task's session; true if a live run was actually cancelled. */
export function cancelTask(id: string): boolean {
  const cancel = runners.get(id)
  if (!cancel) return false
  cancel()
  return true
}

// User-cancel flags, shared by the live run loop and boot-time reattach so a
// cancel reads as 已取消 no matter which page consumed the events. The stall
// watchdog aborts WITHOUT this flag — its aborts must read as failed (retryable),
// not cancelled.
const cancelledTasks = new Set<string>()

// One ledger event, reduced into the task. Shared verbatim by the live run loop
// and the boot-time reattach replay (a page switch/reload kills the in-page
// event loop; the daemon-side session kept going — replay lands the task on its
// true outcome instead of 运行中 forever). Returns true when the turn ended.
// isCancelled lets the live loop keep its stall-aware cancel semantics; ctx
// carries what only the live loop knows (the approvals it answered, the stall
// window it is running under) so a failure reason can name its cause.
// Exported so dev-tests/pp-task-reason-unit.mts can drive the real reducer
// against scripted ledgers instead of restating its rules.
export function reduceLedgerEvent(
  id: string,
  row: unknown,
  isCancelled: () => boolean = () => cancelledTasks.has(id),
  ctx: { approvals?: readonly string[]; stallMs?: () => number } = {},
): boolean {
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
      if (ev.toolUseId && ev.name) {
        if (!t.toolNames) t.toolNames = {}
        t.toolNames[ev.toolUseId] = ev.name
      }
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
    // in three shapes — API mode carries predictionId; the local/worker
    // boltz paths carry engine:"boltz2-local"/"boltz2-worker" — match all.
    // predict_structure carries the whole confidence report inline (sequenceLength)
    // and its savedTo is the PDB itself — capture it too, or tasks where the
    // agent skips analyze_confidence render 没有可展示的结果 despite a good model.
    if (
      !ev.isError && // an errored result must never masquerade as the report
      text.startsWith('{') &&
      (text.includes('"jobs"') ||
        text.includes('"predictionId"') ||
        text.includes('"boltz2-local"') ||
        text.includes('"boltz2-worker"') ||
        text.includes('"sequenceLength"'))
    ) {
      patch(id, (t) => {
        t.resultJson = text.slice(0, 32_000)
      })
    }
    // Artifact paths appear under either key ("savedTo" on fetch/predict outputs,
    // "file" inside the confidence report body), and report previews interleave
    // line-number prefixes — the path itself is always a plain quoted string.
    const paths = [...text.matchAll(/"(?:savedTo|file|pdbPath|reportPath)"\s*:\s*"((?:[^"\\]|\\.)*)"/g)].map(
      (m) => m[1].replace(/\\(.)/g, '$1'),
    )
    const savedTo = paths.find((p) => /\.(pdb|fasta|json)$/.test(p))
    const confidence = paths.find((p) => /confidence\.json$/.test(p))
    patch(id, (t) => {
      const st = [...t.stages].reverse().find((s) => s.status === 'running')
      if (st) st.status = ev.isError ? 'error' : 'done'
      if (ev.isError) {
        // All three, on purpose: foldError is what the user is shown when a
        // folding tool failed (see the field), rootError is the first error, and
        // lastError is the newest symptom that decides a retry.
        if (!t.rootError) t.rootError = text.slice(0, 400)
        t.lastError = text.slice(0, 400)
        if (FOLD_TOOLS.has(ev.toolUseId ? (t.toolNames?.[ev.toolUseId] ?? '') : ''))
          t.foldError = text.slice(0, 400)
      }
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
      if (ev.reason === 'completed') {
        // The agent gave up (tool error) or simply stopped → the turn ends
        // "completed" with no product. That is a failed task, not a fake done —
        // otherwise the wall shows a green ✓ over an empty 3D slot and the
        // result page a bare 没有可展示的结果 with no reason. The test is the
        // task's own deliverable, not "any file appeared": a fetched FASTA is
        // not a structure (Q02388, 2026-10-15).
        if (!hasProductArtifact(t)) {
          t.status = 'failed'
          // The CAUSE first. Showing only the newest error told the 2944-aa
          // Q02388 user that a PDB could not be read, when the tool had already
          // said the sequence was too long and by how much. A failed FOLD tool
          // outranks both: that is the tool whose job was the missing structure.
          t.error = t.foldError ?? t.rootError ?? t.lastError ?? '回合结束但没有产出结构或报告'
        } else {
          t.status = 'done'
          t.lastError = undefined
          t.rootError = undefined
          t.foldError = undefined
        }
      } else if (t.status === 'running') {
        // A user cancel settles as 已取消 — and must NOT read as failed, or the
        // gateway-flake retry below resubmits the task the user just cancelled.
        const cancelled = isCancelled()
        t.status = cancelled ? 'cancelled' : 'failed'
        t.error = cancelled
          ? undefined
          : turnFailureReason(ev, { approvals: ctx.approvals, stallMs: ctx.stallMs?.() })
      }
    })
    if (ev.reason === 'completed' && getTask(id)?.status === 'done') void archiveTask(id)
    return true
  }
  return false
}

// Persist a completed task into the surface archive (report JSON + PDB) so the
// history survives browser storage loss and daemon restarts. The client posts
// ONE small body of workspace-relative paths; the server reads the files itself
// from <tasksRoot>/<taskId>/ — no live-session BFF round trips (the old flow
// needed the session in the daemon registry and took seconds across several
// calls, so a submit loop's page navigation silently dropped ~half the runs).
// Best-effort: a failed write logs and leaves the task unarchived.
async function archiveTask(id: string): Promise<void> {
  const t = getTask(id)
  if (!t?.sessionId) return
  const b64of = (s: string) => btoa(unescape(encodeURIComponent(s)))
  const post = async (files: Record<string, string>, extra: Record<string, unknown> = {}) => {
    const base = location.href.split('#')[0]
    const body = JSON.stringify({
      taskId: id,
      sessionId: t!.sessionId,
      type: t!.type,
      title: t!.title,
      reportPath: 'report.json',
      ...extra,
      files,
    })
    const r = await fetch(new URL('api/archive', base.endsWith('/') ? base : `${base}/`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      // Survive page-close-during-in-flight — but only under the ~64KB request
      // body limit keepalive imposes in Chrome (inline resultJson b64 ≈ 43KB).
      keepalive: body.length < 60000,
    })
    if (!r.ok) throw new Error(`archive: HTTP ${r.status}`)
    patch(id, (t2) => {
      t2.archived = true
    })
  }
  try {
    if (t.type === 'batch') {
      // No on-disk summary: the inline ledger result IS the report (it only
      // exists inline, so it still ships as base64). Per-target PDBs stay in
      // the workspace — the server reads them via the savedTo path map.
      if (!t.resultJson) return
      const parsed = JSON.parse(t.resultJson) as {
        summary?: { total?: number; ok?: number; meanPlddt?: number }
        jobs?: Array<{ status?: string; savedTo?: string }>
      }
      const jobPdbs: Record<string, string> = {}
      for (const j of parsed.jobs ?? []) {
        if (j.status !== 'ok' || typeof j.savedTo !== 'string') continue
        const base = j.savedTo.split('/').pop()
        if (base && !jobPdbs[base]) jobPdbs[base] = j.savedTo
      }
      const bases = Object.keys(jobPdbs).slice(0, 8)
      const mean = typeof parsed.summary?.meanPlddt === 'number' ? parsed.summary.meanPlddt : undefined
      await post(
        { 'report.json': b64of(t.resultJson) },
        {
          workspace:
            bases.length > 0 ? { jobPdbs: Object.fromEntries(bases.map((b) => [b, jobPdbs[b]])) } : undefined,
          ...(mean !== undefined ? { meanPlddt: mean } : {}),
          ...(bases.length > 0 ? { jobPdbs: bases } : {}),
          verdict: `${parsed.summary?.ok ?? '?'}/${parsed.summary?.total ?? '?'} 目标成功`,
        },
      )
      return
    }
    if (t.type === 'search') {
      // The hits report is a workspace file — the server archives it verbatim
      // for offline SearchCard re-renders.
      if (!t.resultSavedTo) return
      await post({}, { workspace: { report: t.resultSavedTo } })
      return
    }
    if (t.type === 'compare') {
      // Compare reports live on disk ({compared, prediction, alphafold} shape);
      // the server derives both models (prediction → model.pdb, AlphaFold ref →
      // pdb-<basename>) plus meanPlddt/verdict straight from the stored report.
      const reportPath =
        t.resultSavedTo ??
        (t.input.accession ? `reports/${t.input.accession.toUpperCase()}.vs-alphafold.json` : undefined)
      if (!reportPath) return
      await post({}, { workspace: { report: reportPath } })
      return
    }

    // single / complex: confidence report + model PDB (+ optional PAE matrix).
    // Inline-ledger results (complex, or single runs whose agent skipped
    // analyze_confidence) still ship base64; everything on disk goes by path.
    const inlineReport = t.type === 'complex' || !t.resultSavedTo ? t.resultJson : undefined
    if (t.type !== 'complex' && !t.resultSavedTo && !t.resultJson) return
    const pdbHint = Object.values(t.savedTo).find((p) => p.endsWith('.pdb'))
    const workspace: { report?: string; pdb?: string } = {}
    if (t.type !== 'complex' && t.resultSavedTo) workspace.report = t.resultSavedTo
    if (pdbHint) workspace.pdb = pdbHint
    await post(inlineReport ? { 'report.json': b64of(inlineReport) } : {}, {
      workspace: Object.keys(workspace).length > 0 ? workspace : undefined,
      ...(t.input.accession ? { accession: t.input.accession } : {}),
    })
  } catch (e) {
    console.warn('[platform] archive write failed:', (e as Error)?.message)
  }
}

// Drives one task end-to-end. The browser cannot mkdir, so the surface server
// creates the task dir, we register it as a workspace, then open the session.
// `sdk` is the DaemonLink (see agnes.ts), not a raw client: every call that has
// to reach the daemon goes through withClient() so a restart mid-flight is a
// rebuild, never a `transport closed: closed` handed to the user.
export async function runTask(
  cfg: { tasksRoot: string },
  sdk: DaemonLink,
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

  // Per-attempt signal, because the watchdog aborts the ATTEMPT and not the task.
  // One controller shared across attempts made the watchdog a dead end: abort()
  // left signal.aborted true forever, so the `!controller.signal.aborted` retry
  // gate above could never open and a hung gateway — the exact failure the retry
  // exists for — settled the task as failed instead of being resubmitted. The
  // 2026-10-15 pasted-2944 run is the case on record: inference produced no events
  // for 209 s, the 180-s watchdog aborted it, and nothing was ever retried.
  let activeController = new AbortController()
  // Set by the watchdog, read by the retry gate: a stalled attempt is NOT a user
  // cancellation, so it must not veto the retry the way a cancel does.
  let stalledAttempt = false
  runners.set(id, () => {
    cancelledTasks.add(id)
    activeController.abort()
  })
  const attempt = async (): Promise<void> => {
    const controller = new AbortController()
    activeController = controller
    stalledAttempt = false
    // Stall watchdog: the model gateway occasionally hangs an inference without a
    // transport error, so neither turn/end nor the events-loop catch ever fires and
    // the task spins in "running" forever. Any ledger event or preview delta counts
    // as life; silence past STALL_MS aborts the session and the retry below resubmits.
    // Boltz runs emit NO events for their whole duration — the watchdog must outlive
    // the tool's own timeout (predict_complex 1300s / batch 900s in the preset), or it
    // kills perfectly healthy predictions mid-flight.
    const STALL_MS = type === 'complex' || type === 'batch' ? 1_400_000 : 180_000
    // A single-type task can fall back to Boltz-2 (agent calls predict_complex after
    // ESMFold 413s on 400+ aa chains) — that fold runs with zero events for minutes,
    // so the moment it is observed the window widens to the complex value; the 180s
    // single window otherwise kills the healthy fallback mid-flight (CASP14 T1024).
    let stallMs = STALL_MS
    let lastActivity = Date.now()
    let stalled = false
    // Every approval this attempt was asked for, in order. A turn that ends
    // "blocked" is the daemon saying an approval did not come back — naming the
    // request is the difference between a card that reads `turn blocked` and one
    // that reads what actually happened.
    const approvals: string[] = []
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > stallMs) {
        stalled = true
        stalledAttempt = true
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
      // Through the link, not the raw client: a daemon restart in the seconds
      // between the HTTP mkdir above and this call would otherwise hand the user
      // `transport closed: closed` for a submission that never started.
      const session = await sdk.withClient(async (c) => {
        await c.workspace.add(cwd)
        return await c.session.new({ cwd, preset: 'standard' })
      })
      patch(id, (t) => {
        t.sessionId = session.id
      })

      session.onPermissionRequest((req: any) => {
        // Defense-in-depth consent: platform prompts are read-only science
        // pipelines and this is not a chat UI, so nothing here may dead-end on
        // an approval. The RETURN value is the answer — see permissionOutcome()
        // for what calling session.answer() instead cost us.
        const options = req?.options ?? req?.payload?.options ?? []
        const outcome = permissionOutcome({ options })
        approvals.push(describeApproval(req, options, outcome))
        return outcome
      })

      void (async () => {
        try {
          const isCancelled = () => controller.signal.aborted && !stalled
          for await (const row of session.events({ preview: true })) {
            lastActivity = Date.now()
            const env = (row as { event?: unknown })?.event ?? row
            const data = ((env as { data?: Record<string, unknown> }).data ?? env) as { name?: string }
            if (
              (env as { type?: string })?.type === 'tool/call' &&
              (data.name === 'predict_complex' || data.name === 'batch_predict')
            )
              stallMs = 1_400_000
            // stallMs is read at call time: the window widens the moment a
            // Boltz fallback is observed, and the reason must quote the window
            // that actually fired.
            if (reduceLedgerEvent(id, row, isCancelled, { approvals, stallMs: () => stallMs })) return
          }
        } catch (e) {
          // Event stream died without a turn/end (transport close, session loss). A running
          // task must not hang forever — surface the failure instead of swallowing it.
          patch(id, (t) => {
            if (t.status === 'running') {
              const cancelled = controller.signal.aborted && !stalled
              t.status = cancelled ? 'cancelled' : 'failed'
              t.error = cancelled ? undefined : `事件流中断：${(e as Error)?.message ?? 'session ended'}`
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

      // The UI cancels via an AbortController on a task that reads "running" from
      // the moment runTask is called — the click can beat the turn start (remote
      // chains add RPC latency before prompt). An aborted signal must abort here,
      // not silently start an un-cancellable turn; AbortError settles as 已取消.
      if (controller.signal.aborted) throw new DOMException('cancelled', 'AbortError')
      await session.prompt(buildPrompt(type, input), { signal: controller.signal })
      patch(id, (t) => {
        // An aborted turn can also RESOLVE here (stopReason=aborted) instead of
        // rejecting — only a non-cancelled settle may read as done.
        if (t.status === 'running' && !controller.signal.aborted) t.status = 'done'
      })
    } catch (e: any) {
      patch(id, (t) => {
        if (t.status === 'running') {
          t.status = /abort/i.test(String(e?.name ?? e)) && !stalled ? 'cancelled' : 'failed'
          t.error = stalled
            ? `STALL_WATCHDOG：超过 ${(stallMs / 1000) | 0}s 无任何事件，会话已中止重试`
            : String(e?.message ?? e).slice(0, 300)
        }
      })
    } finally {
      clearInterval(watchdog)
    }
  }

  void (async () => {
    // Bounded auto-retry for transient failures: the model gateway drops large
    // agent rounds (TRANSPORT), the watchdog kills hung turns, and tool-level
    // flakiness (boltz API 5xx, rate limits, worker busy) surfaces as a
    // "completed" turn with zero artifacts and a recorded error. Each retry is
    // a fresh session; the checkpoint below is the single arbiter via
    // isTransientError. Tasks that DID produce artifacts never auto-retry —
    // a partial result plus the manual ↻ resubmit beats wiping a finished PDB
    // to re-roll the same prediction.
    const MAX_ATTEMPTS = 3
    try {
      for (let n = 1; ; n++) {
        await attempt()
        const t = getTask(id)
        const retryable = shouldRetryAttempt({
          attempt: n,
          maxAttempts: MAX_ATTEMPTS,
          // "The user cancelled" — not "the signal is aborted", which a stalled
          // attempt also makes true (see stalledAttempt above).
          userCancelled: cancelledTasks.has(id),
          status: t?.status,
          // Product-aware, like the turn/end test above: a leftover fetched
          // FASTA must not veto the retry of a failed fold (Q02388).
          hasProductArtifact: !!t && hasProductArtifact(t),
          // Either end of the error chain: t.error is now the CAUSE, so a
          // transient symptom that came later must still be able to earn a
          // retry rather than being masked by a deterministic first failure.
          error: t?.error,
          lastError: t?.lastError,
        })
        if (!retryable) break
        console.log(
          `[platform] attempt ${n} ${stalledAttempt ? 'was aborted by the stall watchdog' : 'failed transiently'} ` +
            `(${(t!.error ?? '').slice(0, 120)}), auto-retrying`,
        )
        await new Promise((r) => setTimeout(r, n === 1 ? 3000 : 8000))
        patch(id, (t2) => {
          t2.status = 'running'
          t2.error = undefined
          t2.stages = []
          t2.savedTo = {}
          t2.resultSavedTo = undefined
          t2.resultJson = undefined
          t2.previewTail = ''
          // A fresh attempt gets a fresh cause; a stale rootError would be
          // reported as the reason for a failure it had nothing to do with.
          t2.lastError = undefined
          t2.rootError = undefined
          t2.foldError = undefined
        })
      }
    } finally {
      runners.delete(id)
      cancelledTasks.delete(id)
    }
  })()

  return {
    cancel: () => {
      // Same path as the UI's cancel affordance: mark it a user cancellation and
      // abort whatever attempt is live right now.
      cancelledTasks.add(id)
      activeController.abort()
    },
  }
}

// Recovery for tasks stranded by a page switch/reload/tab close — and now by a
// daemon restart too, since main.tsx re-runs this whenever the link replaces a
// client the SDK latched closed: the run loop lived in the old page (or on the
// dead client), but the daemon-side session kept going (or already finished).
// Reattach and replay the journal through the same reducer — the task lands on
// its true outcome, archives what the dead page never could, and live events
// keep flowing if the turn is still running. Sessions that no longer exist
// (daemon restart) settle failed honestly instead of spinning.
export async function reattachRunningTasks(sdk: DaemonLink): Promise<void> {
  const stranded = getTasks().filter((t) => t.status === 'running')
  for (const t of stranded) {
    const id = t.id
    if (!t.sessionId || !sdk) {
      patch(id, (t2) => {
        if (t2.status === 'running') {
          t2.status = 'failed'
          t2.error = '页面刷新时会话尚未建立 — 请重新提交'
        }
      })
      continue
    }
    try {
      // load (not attach): attach() delivers its journal replay BEFORE any
      // events() iterator exists, so the listener registers too late and the
      // replayed rows vanish. events() attaches internally — its listener is
      // live before the attach round-trip, so the replay lands in the queue.
      // load also re-establishes the daemon-side session for later BFF reads
      // (archive), and rejects unknown sessions honestly.
      const session = await sdk.withClient((c) => c.session.load(t.sessionId))
      // Replay from zero re-derives every stage/artifact; start clean so the
      // old page's partial ledger can't duplicate rows or shadow real results.
      patch(id, (t2) => {
        t2.stages = []
        t2.savedTo = {}
        t2.resultSavedTo = undefined
        t2.resultJson = undefined
        t2.lastError = undefined
        t2.rootError = undefined
        t2.foldError = undefined
      })
      runners.set(id, () => {
        cancelledTasks.add(id)
        void session.cancel?.().catch(() => {})
      })
      void (async () => {
        try {
          for await (const row of session.events({ preview: true })) {
            if (reduceLedgerEvent(id, row)) return
          }
          // Journal exhausted without turn/end: the daemon died mid-turn.
          patch(id, (t2) => {
            if (t2.status === 'running') {
              t2.status = 'failed'
              t2.error = '会话在后台中断且无完成事件（daemon 重启？）— 可重新提交'
            }
          })
        } catch (e) {
          patch(id, (t2) => {
            if (t2.status === 'running') {
              t2.status = 'failed'
              t2.error = `重连会话事件流失败：${(e as Error)?.message ?? 'session ended'}`.slice(0, 300)
            }
          })
        } finally {
          runners.delete(id)
          cancelledTasks.delete(id)
        }
      })()
    } catch (e) {
      patch(id, (t2) => {
        if (t2.status === 'running') {
          t2.status = 'failed'
          t2.error = `会话不存在（daemon 重启或已清理）：${(e as Error)?.message ?? ''}`.slice(0, 300)
        }
      })
    }
  }
}
