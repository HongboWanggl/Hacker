import {
  createClient,
  memoryJournal,
  TransportClosed,
} from '../../../../../packages/sdk/src/index.browser.ts'
import type { PlatformConfig } from './config.ts'

// Same client pattern as packages/web/src/app.ts — local authority over the
// loopback WS (public chains rewrite Origin/Host at the proxy).
export async function connectDaemon(cfg: PlatformConfig) {
  if (!cfg.wsUrl) throw new Error('daemon WS URL unavailable (config.json wsUrl is null)')
  const client = createClient({
    transport: { kind: 'ws', url: cfg.wsUrl, protocols: ['agnes-v1'] },
    auth: { kind: 'local' },
    journal: memoryJournal(),
  })
  await client.initialize()
  return client
}

export type DaemonClient = Awaited<ReturnType<typeof connectDaemon>>
export type LinkState = 'connecting' | 'up' | 'down'

export type DaemonLink = {
  /** Truthful state of the browser↔daemon channel, for the shell badge. */
  state(): LinkState
  onState(cb: (s: LinkState) => void): () => void
  /** A live client, opening (or reopening) the transport as needed. */
  client(): Promise<DaemonClient>
  /** Run `fn` against a live client; a dead transport means reopen + one retry. */
  withClient<T>(fn: (c: DaemonClient) => Promise<T>): Promise<T>
}

function isTransportClosed(e: unknown): boolean {
  return e instanceof TransportClosed || (e as { code?: string } | null)?.code === 'transport-closed'
}

/**
 * The platform's single handle on the daemon channel.
 *
 * The SDK reconnects on its own for a transport drop nobody asked for (its loop
 * retries until the socket is back and every attached session has recovered).
 * What it cannot survive is a *deliberate* shutdown: `daemon.notice{kind:
 * 'shutting_down'}` latches the client closed for good, so a daemon restart —
 * the routine `systemctl --user restart agnes-daemon` — leaves the open tab
 * holding a corpse. Every later call then rejects `transport closed: closed`
 * while the badge still says 服务正常, and nothing short of a page reload
 * recovers. Observed live: a submission minutes after a restart died this way
 * (task dir created over HTTP, `session.new` refused over the dead WS).
 *
 * So this link owns exactly that one job: notice the latch, drop the client,
 * build a fresh one, and keep the badge honest in between. A request that
 * happens to land on the dead client is rebuilt and retried once — never more,
 * so a genuinely down daemon surfaces as an error instead of a silent hang.
 */
export function createDaemonLink(
  cfg: PlatformConfig,
  opts: {
    connect?: (cfg: PlatformConfig) => Promise<DaemonClient>
    /** Delay before a background reopen attempt while the daemon is away. */
    retryMs?: number
    /** A *replacement* client just came up — the caller replays its live state. */
    onRebuilt?: () => void
  } = {},
): DaemonLink {
  const connect = opts.connect ?? connectDaemon
  const retryMs = opts.retryMs ?? 3000
  let state: LinkState = 'connecting'
  let current: DaemonClient | null = null
  let opening: Promise<DaemonClient> | null = null
  let healTimer: ReturnType<typeof setTimeout> | null = null
  let hadLive = false
  const watchers = new Set<(s: LinkState) => void>()

  const setState = (next: LinkState) => {
    if (state === next) return
    state = next
    for (const w of watchers) w(state)
  }

  const scheduleHeal = () => {
    if (healTimer) return
    healTimer = setTimeout(() => {
      healTimer = null
      if (current) return
      void open().catch(() => scheduleHeal())
    }, retryMs)
  }

  const retire = (dead: DaemonClient) => {
    if (current !== dead) return
    current = null
    setState('down')
    scheduleHeal()
  }

  const watch = (c: DaemonClient) => {
    c.on('connectionStateChanged', (s) => {
      if (current !== c) return
      setState(s === 'connected' ? 'up' : 'down')
    })
    c.on('closed', () => retire(c))
  }

  function open(): Promise<DaemonClient> {
    if (current && !current.isClosed) return Promise.resolve(current)
    if (opening) return opening
    const p = connect(cfg)
      .then((c) => {
        current = c
        watch(c)
        setState('up')
        const replaced = hadLive
        hadLive = true
        if (replaced) opts.onRebuilt?.()
        return c
      })
      .catch((e: unknown) => {
        setState('down')
        throw e
      })
      .finally(() => {
        if (opening === p) opening = null
      })
    opening = p
    return p
  }

  const withClient = async <T>(fn: (c: DaemonClient) => Promise<T>): Promise<T> => {
    const first = await open()
    try {
      return await fn(first)
    } catch (e) {
      if (!isTransportClosed(e)) throw e
      // The client this call went to is gone for good; one rebuild, one retry.
      retire(first)
      return await fn(await open())
    }
  }

  return {
    state: () => state,
    onState: (cb) => {
      watchers.add(cb)
      return () => watchers.delete(cb)
    },
    client: open,
    withClient,
  }
}
