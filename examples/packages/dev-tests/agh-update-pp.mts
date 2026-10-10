import { createClient, memoryJournal } from '/Users/wanghanbao/agnes-harness/packages/sdk/src/index.node.ts'
import { randomUUID } from 'node:crypto'

const client = createClient({ transport: { kind: 'unix', path: '/Users/wanghanbao/agh-home/data/daemon/agnesd.sock' }, auth: { kind: 'local' }, journal: memoryJournal() })
await client.initialize()
const common = { profile: 'local-dev', clientId: await client.clientId() }
const op = async (kind: string, params: any) => {
  const receipt = await (client.packages as any)[kind]({ ...common, commandId: `cmd-${randomUUID()}`, ...params })
  for (let i = 0; i < 300; i++) {
    const result = await (client.packages as any).operation.get({ profile: common.profile, operationId: receipt.operationId })
    if (result.state === 'failed' || result.state === 'cancelled') throw new Error(`${kind}: ${result.error?.code ?? result.state}`)
    if (['completed', 'rolled-back'].includes(result.state)) return result
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`${kind}: timeout`)
}
const source = { type: 'file', ref: 'file:./examples/packages/protein-predictor' }
const { preview } = await op('inspect', { source })
console.log('preview integrity:', preview.integrity.slice(0, 24))
const upd = await op('update', { id: preview.id, source, expectedIntegrity: preview.integrity })
console.log('update: completed')
await op('trust', { id: preview.id, expectedIntegrity: preview.integrity, capabilityHash: preview.capabilityHash })
console.log('trust: ok')
await op('enable', { id: preview.id })
console.log('enable: ok')
const list = await (client.packages as any).list({ profile: 'local-dev' })
console.log(list.packages.filter((p: any) => p.id.startsWith('@aghes')).map((p: any) => `${p.id} desired=${p.desired} actual=${p.actual} trusted=${p.trusted}`).join('\n'))
process.exit(0)
