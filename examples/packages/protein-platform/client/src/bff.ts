import type { PlatformConfig } from './config.ts'

// Services facade shaped exactly like the AGH toolview host's ctx.agnes.services —
// backed by the same-origin client-modules BFF, which dispatches into the
// protein-view extension services with the session's workspace as cwd.

export type PvServices = { call: (service: string, input: Record<string, unknown>) => Promise<any> }

let cfgRef: PlatformConfig | null = null
const sessionIdRef = { current: null as string | null }
let singleton: PvServices | null = null

export function initServices(cfg: PlatformConfig): PvServices {
  cfgRef = cfg
  singleton ??= {
    async call(service, input) {
      const sessionId = sessionIdRef.current
      if (!sessionId) throw new Error('no active session')
      const r = await fetch(cfgRef!.bffPath, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profile: cfgRef!.profile,
          rowId: cfgRef!.rowId,
          sessionId,
          service,
          input,
        }),
      })
      if (!r.ok) throw new Error(`${service}: HTTP ${r.status}`)
      const j = (await r.json()) as { output?: unknown; error?: string }
      if (j.error) throw new Error(`${service}: ${j.error}`)
      return j.output
    },
  }
  return singleton
}

/** BFF dispatches with the given session's workspace as cwd — set per active task. */
export function setServicesSession(sessionId: string | null): void {
  sessionIdRef.current = sessionId
}

export function getServices(): PvServices {
  if (!singleton) throw new Error('services not initialized')
  return singleton
}

/** Explicit-session dispatch for non-UI callers (the orchestrator's archive write
 *  runs outside the result page, so the "current session" ref is meaningless). */
export async function bffCall(sessionId: string, service: string, input: Record<string, unknown>): Promise<any> {
  const r = await fetch(cfgRef!.bffPath, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: cfgRef!.profile, rowId: cfgRef!.rowId, sessionId, service, input }),
  })
  if (!r.ok) throw new Error(`${service}: HTTP ${r.status}`)
  const j = (await r.json()) as { output?: unknown; error?: string }
  if (j.error) throw new Error(`${service}: ${j.error}`)
  return j.output
}

export type ArchiveMeta = {
  taskId: string
  type?: string
  title?: string
  savedAt: string
  meanPlddt?: number
  verdict?: string
  reportPath?: string
  pdbPath?: string
}

/** Archive list for history views; fails soft to [] (surface unreachable). */
export async function listArchive(): Promise<ArchiveMeta[]> {
  try {
    const r = await fetch(new URL('api/archive', baseHref()))
    if (!r.ok) return []
    return ((await r.json()) as unknown) as ArchiveMeta[]
  } catch {
    return []
  }
}

/** Services shim backed by the completed-task archive instead of a live session:
 *  the pv components cannot tell the difference, so an archived result page renders
 *  fully interactive (3D + curve + sequence) with zero live backend. */
export function archivedServices(taskId: string): PvServices {
  const get = async (path: string) => {
    const r = await fetch(new URL(path, baseHref()))
    if (!r.ok) throw new Error(`archive: HTTP ${r.status}`)
    return ((await r.json()) as { output?: unknown }).output
  }
  return {
    async call(service) {
      if (service === 'protein.report') return get(`api/archive/${taskId}/report`)
      if (service === 'protein.structure') return get(`api/archive/${taskId}/structure`)
      if (service === 'protein.pae') return get(`api/archive/${taskId}/pae`)
      throw new Error(`${service}: not available for archived tasks`)
    },
  }
}

function baseHref(): string {
  const base = location.href.split('#')[0]
  return base.endsWith('/') ? base : `${base}/`
}
