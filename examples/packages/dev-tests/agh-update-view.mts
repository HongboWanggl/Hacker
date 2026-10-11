import { randomUUID } from 'node:crypto'
import { createClient, memoryJournal } from '../../../packages/sdk/src/index.node.ts'

// Structural typing for the packages admin surface — the SDK's generated types
// are narrower than what the daemon accepts, and dev-tooling only needs these
// four calls plus the operation poll.
type PkgAdmin = {
  [kind: string]: (params: Record<string, unknown>) => Promise<{ operationId: string }>
}
type PkgOpResult = { state: string; error?: { code?: string } }

const client = createClient({
  transport: { kind: 'unix', path: `${process.env.AGH_HOME}/data/daemon/agnesd.sock` },
  auth: { kind: 'local' },
  journal: memoryJournal(),
})
await client.initialize()
const common = { profile: 'local-dev', clientId: await client.clientId() }
const pkg = client.packages as unknown as PkgAdmin
const op = async (kind: string, params: Record<string, unknown>) => {
  const receipt = await pkg[kind]({
    ...common,
    commandId: `cmd-${randomUUID()}`,
    ...params,
  })
  for (let i = 0; i < 300; i++) {
    const result = (await pkg['operation.get']({
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
const source = { type: 'file', ref: 'file:./examples/packages/protein-view' }
const { preview } = await op('inspect', { source })
console.log('preview integrity:', preview.integrity.slice(0, 24))
await op('update', { id: preview.id, source, expectedIntegrity: preview.integrity })
console.log('update: completed')
await op('trust', {
  id: preview.id,
  expectedIntegrity: preview.integrity,
  capabilityHash: preview.capabilityHash,
})
console.log('trust: ok')
await op('enable', { id: preview.id })
console.log('enable: ok')
const list = (await pkg.list({ profile: 'local-dev' })) as {
  packages: Array<{ id: string; desired: string; actual: string; trusted: boolean }>
}
console.log(
  list.packages
    .filter((p) => p.id.startsWith('@aghes'))
    .map((p) => `${p.id} desired=${p.desired} actual=${p.actual} trusted=${p.trusted}`)
    .join('\n'),
)
process.exit(0)
