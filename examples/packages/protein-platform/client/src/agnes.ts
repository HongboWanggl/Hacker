import { createClient, memoryJournal } from '../../../../../packages/sdk/src/index.browser.ts'
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
