import { STAGE_LABEL, TASK_TYPE_LABEL, buildPrompt, type TaskInput, type TaskType } from './prompts.ts'

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
  if (input.accession) return input.accession
  if (input.name) return input.name
  if (input.sequence) return `自定义序列 · ${input.sequence.trim().length} aa`
  return TASK_TYPE_LABEL[type]
}

export type RunHandle = { cancel: () => void }

// Drives one task end-to-end. The browser cannot mkdir, so the surface server
// creates the task dir, we register it as a workspace, then open the session.
export async function runTask(
  cfg: { tasksRoot: string },
  sdk: any,
  type: TaskType,
  input: TaskInput,
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
    const STALL_MS = 180_000
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
        body: JSON.stringify({ taskId: id }),
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
        if (allow) void session.answer({ requestId: req.requestId ?? req.id, response: { optionId: allow.optionId ?? allow.kind } }).catch(() => {})
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
                if (!existing) t.stages.push({ tool: ev.name!, label: STAGE_LABEL[ev.name!] ?? ev.name!, status: 'running' })
              })
            } else if (kind === 'tool/result') {
              const text = typeof ev?.content?.[0]?.text === 'string' ? ev.content[0].text : ''
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
    if (t?.status === 'failed' && /STALL_WATCHDOG|TRANSPORT|TURN_ERROR|status=\?|事件流中断|ECONN|EAI_AGAIN|socket hang up|fetch failed|reset/i.test(t.error ?? '')) {
      patch(id, (t2) => {
        t2.status = 'running'
        t2.error = undefined
        t2.stages = []
        t2.savedTo = {}
        t2.resultSavedTo = undefined
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
