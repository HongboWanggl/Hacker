import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createClient, memoryJournal } from '../../../packages/sdk/src/index.node.ts'

// Trust the protein-platform Surface deploy directory. The deploy tree must live
// INSIDE the profile directory (manager.ts workspacePath requires containment),
// so the canonical tree in the repo is synced to
// <AGH_HOME>/profiles/<profile>/deploy/protein-platform first, then signed into
// agnes.lock via packages.trustWorkspace.
const home = process.env.AGH_HOME!
const profile = process.env.AGNES_PROFILE ?? 'local-dev'
const repoDeploy = new URL('../protein-platform/deploy/', import.meta.url).pathname
const target = join(home, 'profiles', profile, 'deploy', 'protein-platform')

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const entry of ['manifest.json', 'surfaces']) {
  cpSync(join(repoDeploy, entry), join(target, entry), { recursive: true })
}

const client = createClient({
  transport: { kind: 'unix', path: `${home}/data/daemon/agnesd.sock` },
  auth: { kind: 'local' },
  journal: memoryJournal(),
})
await client.initialize()
const { hash } = await (client.packages as any).trustWorkspace({
  profile,
  clientId: await client.clientId(),
  commandId: `cmd-trust-${Date.now()}`,
  deployDir: target,
})
console.log(`trusted ${target} (hash ${hash.slice(0, 16)}…)`)
process.exit(0)
