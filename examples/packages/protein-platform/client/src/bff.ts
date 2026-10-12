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
