// Publish one or more example packages by name, e.g.:
//   node --import tsx agh-update-pkg.mts protein-view protein-predictor
// Same inspect → update → trust → enable flow as agh-update-view.mts, but the
// package list comes from argv so a tool-code edit can actually reach the
// daemon's published snapshot (the view-only script left boltz.mjs stale).
import { randomUUID } from 'node:crypto'
import { createClient, memoryJournal } from '../../../packages/sdk/src/index.node.ts'

type PkgAdmin = {
  [kind: string]: (params: Record<string, unknown>) => Promise<{ operationId: string }>
}
type PkgOpResult = { state: string; error?: { code?: string } }

const names = process.argv.slice(2)
if (names.length === 0) {
  console.error('usage: agh-update-pkg.mts <package-dir-name> [...]')
  process.exit(2)
}

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

for (const name of names) {
  const source = { type: 'file', ref: `file:./examples/packages/${name}` }
  const { preview } = await op('inspect', { source })
  console.log(`${name}: preview integrity ${preview.integrity.slice(0, 24)}`)
  await op('update', { id: preview.id, source, expectedIntegrity: preview.integrity })
  await op('trust', {
    id: preview.id,
    expectedIntegrity: preview.integrity,
    capabilityHash: preview.capabilityHash,
  })
  await op('enable', { id: preview.id })
  console.log(`${name}: published (update/trust/enable ok)`)
}
process.exit(0)
