// BFF health probe with a REAL session: the authoritative check when a BFF 503
// is suspected. Never probe with a made-up sessionId — an unknown session makes
// the worker throw E_WORKSPACE_REQUIRED, which the package-admin catch masks as
// SEMANTIC_REJECTED/E_PACKAGE_STATE, and two rounds were lost to that mirage.
// Usage: AGH_HOME=$HOME/agh-home node --import tsx pp-bff-probe.mts
import { mkdirSync, writeFileSync } from 'node:fs'
import { createClient, memoryJournal } from '../../../packages/sdk/src/index.node.ts'

const home = process.env.AGH_HOME ?? `${process.env.HOME}/agh-home`
const client = createClient({
  transport: { kind: 'unix', path: `${home}/data/daemon/agnesd.sock` },
  auth: { kind: 'local' },
  journal: memoryJournal(),
})
await client.initialize()
// biome-ignore lint/suspicious/noExplicitAny: probe surface, not product code
const anyClient = client as any
// 1. Real workspace + session, mirroring the platform orchestrator's flow.
const taskId = `bffprobe${Date.now().toString(36)}`
const cwd = `${home}/protein-platform/tasks/${taskId}`
mkdirSync(cwd, { recursive: true })
writeFileSync(`${cwd}/model.pdb`, 'ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00 80.00\n')
await anyClient.workspace.add(cwd)
const session = await anyClient.session.new({ cwd })
const sessionId = session.id
console.log('session:', sessionId)
// 2. BFF callService against the REAL session.
try {
  const r = await anyClient.clientModules.callService({
    profile: 'local-dev',
    rowId: 'web:@aghes/protein-view',
    sessionId,
    service: 'protein.structure',
    input: { path: 'model.pdb' },
  })
  console.log('REAL-SESSION OK:', JSON.stringify(r).slice(0, 200))
} catch (e) {
  console.log(
    'REAL-SESSION FAIL:',
    (e as Error).message,
    JSON.stringify((e as { data?: unknown }).data ?? null),
  )
}
// 3. Bogus session for contrast (always fails; see header comment).
try {
  await anyClient.clientModules.callService({
    profile: 'local-dev',
    rowId: 'web:@aghes/protein-view',
    sessionId: 'bogus-does-not-exist',
    service: 'protein.structure',
    input: { path: 'model.pdb' },
  })
  console.log('BOGUS unexpectedly ok')
} catch (e) {
  console.log(
    'BOGUS fails as expected:',
    (e as Error).message,
    JSON.stringify((e as { data?: unknown }).data ?? null),
  )
}
process.exit(0)
