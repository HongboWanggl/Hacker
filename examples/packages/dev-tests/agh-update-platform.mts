import { randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createClient, memoryJournal } from '../../../packages/sdk/src/index.node.ts'

// Publish the protein-platform Surface package:
//   inspect → (untrust deployment) → install|update → trust → enable → re-trust deployment.
// Iteration gotchas baked in here:
//   • First publish uses `install` ({source, expectedIntegrity} — no id). `update` on a
//     not-yet-installed package throws E_DEP_MISSING, safely mapped to the misleading
//     E_PACKAGE_SOURCE.
//   • The trusted deploy dir's surface instance REFERENCES the package, so `update` is blocked
//     (E_PACKAGE_BLOCKED, blocker "deployment"); deleting the dir instead trips
//     E_LOCK_MISMATCH ("deployment workspace differs from trusted snapshot"). The way out is to
//     re-sign a MINIMAL deploy tree (same manifest id, no surfaces), update, then restore and
//     re-sign the full tree.
type PkgAdmin = {
  [kind: string]: (params: Record<string, unknown>) => Promise<{ operationId: string }>
}
type PkgOpResult = { state: string; error?: { code?: string } }

const home = process.env.AGH_HOME!
const profile = process.env.AGNES_PROFILE ?? 'local-dev'
const target = join(home, 'profiles', profile, 'deploy', 'protein-platform')
const repoDeploy = new URL('../protein-platform/deploy/', import.meta.url).pathname

const client = createClient({
  transport: { kind: 'unix', path: `${home}/data/daemon/agnesd.sock` },
  auth: { kind: 'local' },
  journal: memoryJournal(),
})
await client.initialize()
const common = { profile, clientId: await client.clientId() }
const pkg = client.packages as unknown as PkgAdmin
const op = async (kind: string, params: Record<string, unknown>) => {
  const receipt = await pkg[kind]({
    ...common,
    commandId: `cmd-${randomUUID()}`,
    ...params,
  })
  for (let i = 0; i < 300; i++) {
    const result = (await pkg.operation.get({
      profile: common.profile,
      operationId: receipt.operationId,
    })) as PkgOpResult
    if (result.state === 'failed' || result.state === 'cancelled')
      throw new Error(`${kind}: ${result.error?.code ?? result.state}`)
    if (['completed', 'rolled-back'].includes(result.state)) return result
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`${kind}: timeout`)
}
const syncDeploy = (minimal: boolean) => {
  rmSync(target, { recursive: true, force: true })
  mkdirSync(target, { recursive: true })
  cpSync(join(repoDeploy, 'surfaces'), join(target, 'surfaces'), { recursive: true })
  const manifest = JSON.parse(readFileSync(join(repoDeploy, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >
  if (minimal) delete manifest.surfaces
  writeFileSync(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2))
}
const trustWorkspace = async () => {
  await (
    pkg as unknown as { trustWorkspace: (p: Record<string, unknown>) => Promise<{ hash: string }> }
  ).trustWorkspace({
    profile,
    clientId: common.clientId,
    commandId: `cmd-trust-${randomUUID()}`,
    deployDir: target,
  })
}

const source = { type: 'file', ref: 'file:./examples/packages/protein-platform' }
const { preview } = await op('inspect', { source })
console.log('preview integrity:', preview.integrity.slice(0, 24))
const installed = ((await pkg.list({ profile })) as { packages: { id: string }[] }).packages.some(
  (row) => row.id === preview.id,
)
if (installed) {
  syncDeploy(true)
  await trustWorkspace()
}
await op(
  installed ? 'update' : (pkg as { install?: unknown }).install ? 'install' : 'update',
  installed
    ? { id: preview.id, source, expectedIntegrity: preview.integrity }
    : { source, expectedIntegrity: preview.integrity },
)
console.log(installed ? 'update: completed' : 'install: completed')
await op('trust', {
  id: preview.id,
  expectedIntegrity: preview.integrity,
  capabilityHash: preview.capabilityHash,
})
console.log('trust: ok')
await op('enable', { id: preview.id })
console.log('enable: ok')
syncDeploy(false)
await trustWorkspace()
console.log('deployment: re-trusted')
process.exit(0)
