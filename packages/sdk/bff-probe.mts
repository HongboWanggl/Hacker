import { createClient, memoryJournal } from './src/index.node.ts'
const home = process.env.AGH_HOME ?? `${process.env.HOME}/agh-home`
const client = createClient({
  transport: { kind: 'unix', path: `${home}/data/daemon/agnesd.sock` },
  auth: { kind: 'local' },
  journal: memoryJournal(),
})
await client.initialize()
const anyClient = client as any
try {
  const r = await anyClient.clientModules.callService({
    profile: 'local-dev', rowId: 'web:@aghes/protein-view', sessionId: 'bogus', service: 'protein.report', input: { path: 'x' },
  })
  console.log('ok', JSON.stringify(r).slice(0, 200))
} catch (e: any) {
  console.log('keys:', Object.getOwnPropertyNames(e))
  console.log('message:', e.message)
  console.log('data:', JSON.stringify(e.data ?? e.cause?.data ?? null))
  console.log('cause:', JSON.stringify(e.cause ?? null)?.slice(0, 500))
}
try {
  const l = await anyClient.clientModules.list('local-dev')
  console.log('list rows:', JSON.stringify(l)?.slice(0, 300))
} catch (e: any) {
  console.log('list failed:', e.message, JSON.stringify(e.data ?? null)?.slice(0, 300))
}
process.exit(0)
