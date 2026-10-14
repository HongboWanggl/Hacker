// What the WALL says after a scripted ledger — driven through the real reducer.
//
//   node --import tsx pp-task-reason-unit.mts
//
// pp-permission-unit.mts pins the reason FORMATTERS. This drives
// reduceLedgerEvent itself, because the defect that survived the approval fix
// was a choice inside it: the 2944-aa Q02388 run reported
// `Cannot read structures/Q02388.pdb` — a downstream symptom of the agent
// walking its numbered plan past a refusal — while the tool had said something
// far more useful and far earlier:
//   `Sequence too long (2944 residues); ESMFold endpoint handles short chains
//    (<1000, ideally <400) — and 1000 is the ceiling for predict_complex`.
// The first error is the cause; a card must lead with it.
import './pp-task-reason-stub.mjs' // side effect: localStorage + seeded rows. MUST be first.
import {
  getTask,
  reattachRunningTasks,
  reduceLedgerEvent,
} from '../protein-platform/client/src/orchestrator.ts'
import { isTransientError } from '../protein-platform/client/src/transient.ts'

const fails: string[] = []
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, extra)
  if (!cond) fails.push(name)
}

const errResult = (toolUseId: string, text: string) => ({
  type: 'tool/result',
  toolUseId,
  isError: true,
  content: [{ type: 'text', text }],
})
const okResult = (toolUseId: string, text: string) => ({
  type: 'tool/result',
  toolUseId,
  isError: false,
  content: [{ type: 'text', text }],
})
const call = (toolUseId: string, name: string) => ({ type: 'tool/call', toolUseId, name })
const end = (reason = 'completed') => ({ type: 'turn/end', reason })

/** Reduce one ledger, in order, and say whether the turn ended. */
const reduce = (id: string, rows: unknown[], ctx = {}) => {
  let ended = false
  for (const r of rows) ended = reduceLedgerEvent(id, r, () => false, ctx) || ended
  return ended
}

const CEILING =
  'Sequence too long (2944 residues); ESMFold endpoint handles short chains (<1000, ideally <400) — and 1000 is the ceiling for predict_complex.'
const SYMPTOM = 'Cannot read structures/Q02388.pdb. Pass the path exactly as returned by predict_structure.'

// --- the incident, replayed --------------------------------------------------
ok(
  'turn/end is reported to the caller',
  reduce('long-chain', [
    call('t0', 'uniprot_fetch'),
    okResult('t0', '{"accession":"Q02388","savedTo":"sequences/Q02388.fasta"}'),
    call('t1', 'predict_structure'),
    errResult('t1', CEILING),
    call('t2', 'analyze_confidence'),
    errResult('t2', SYMPTOM),
    end(),
  ]),
)
const lc = getTask('long-chain')!
ok('a completed turn with no structure is 失败, never 已完成', lc.status === 'failed', lc.status)
// The FASTA from step 1 is exactly what used to be mistaken for a product.
ok('a fetched FASTA is not a product', lc.savedTo.t0 === 'sequences/Q02388.fasta')
ok('the reason is the CAUSE, not the newest symptom', lc.error === CEILING, lc.error?.slice(0, 90))
ok('the reason names the residue count', !!lc.error?.includes('2944'))
ok('the reason names the ceiling', !!lc.error?.includes('1000'))
ok('the reason is not the downstream PDB failure', !lc.error?.includes('Cannot read'))
ok('the symptom is still recorded for the retry judgement', lc.lastError === SYMPTOM)
ok('both errors closed their stage as errors', lc.stages.filter((s) => s.status === 'error').length === 2)
// Deterministic failure: a length refusal must not burn two more GPU attempts.
ok('a length refusal does not auto-retry', !isTransientError(lc.error) && !isTransientError(lc.lastError))

// --- the retry judgement still sees a transient symptom ----------------------
reduce('long-chain-then-transient', [
  call('t1', 'predict_structure'),
  errResult('t1', CEILING),
  call('t2', 'analyze_confidence'),
  errResult('t2', 'TRANSPORT: connection reset'),
  end(),
])
const lt = getTask('long-chain-then-transient')!
ok('the displayed reason stays the cause', lt.error === CEILING, lt.error?.slice(0, 60))
ok(
  'a transient symptom later in the chain still earns a retry',
  isTransientError(lt.error) || isTransientError(lt.lastError),
)

// --- an approval-refused turn --------------------------------------------------
const blocked = reduce('blocked-turn', [call('t1', 'shell'), end('blocked')], {
  approvals: ['shell → 拒绝'],
  stallMs: () => 180_000,
})
ok('a blocked turn reports blocked', blocked)
const bt = getTask('blocked-turn')!
ok(
  'blocked is 失败 with a reason that names the tool',
  bt.status === 'failed' && !!bt.error?.includes('shell'),
  bt.error,
)
ok('blocked is not the bare literal', bt.error !== 'turn blocked')
ok('blocked stays retryable', isTransientError(bt.error))

// --- the stall watchdog --------------------------------------------------------
reduce('stall-abort', [call('t1', 'predict_structure'), end('aborted')], { stallMs: () => 1_400_000 })
const st = getTask('stall-abort')!
ok('an abort becomes the watchdog text', !!st.error?.startsWith('STALL_WATCHDOG'), st.error)
ok('the watchdog quotes the widened window', !!st.error?.includes('1400'), st.error)
ok('the watchdog text is retryable', isTransientError(st.error))

// --- anything else keeps the daemon's own words -------------------------------
reduce('unknown-reason', [end('error')])
const ur = getTask('unknown-reason')!
ok('an unexplained turn still gets a readable reason', !!ur.error && ur.error.length > 4, ur.error)

// --- the honest positive: a real structure ------------------------------------
reduce('genuine-done', [
  call('t1', 'predict_structure'),
  okResult('t1', '{"savedTo":"structures/Q02388.pdb"}'),
  end(),
])
const gd = getTask('genuine-done')!
ok('a PDB-backed turn is 已完成', gd.status === 'done', gd.status)
ok('a 已完成 task carries no error', !gd.error && !gd.lastError && !gd.rootError)

// --- a completed turn with no error at all ------------------------------------
reduce('no-error-at-all', [call('t1', 'predict_structure'), end()])
const na = getTask('no-error-at-all')!
ok('no artifacts and no error is still 失败', na.status === 'failed', na.status)
ok('and it says so instead of showing a blank', !!na.error, na.error)

// --- the FASTA trap, in isolation ---------------------------------------------
reduce('fasta-only', [
  call('t0', 'uniprot_fetch'),
  okResult('t0', '{"accession":"Q02388","savedTo":"sequences/Q02388.fasta"}'),
  end(),
])
const fo = getTask('fasta-only')!
ok('a FASTA-only run is 失败, not 已完成', fo.status === 'failed', fo.status)
ok('the FASTA was still captured as an artifact', !!fo.savedTo.t0)

// --- nothing was archived by any of the above ---------------------------------
// archiveTask() is only reachable for a genuine 已完成 (it needs a sessionId);
// a fake-done would have tried to POST. No sessionId here, so a fake done would
// have thrown — this pins that the 已完成 row above did not reach it.
ok('the fake-done rows never became archivable', getTask('long-chain')!.archived !== true)

// --- reattach must not fabricate a reason -------------------------------------
// The replay path has no stall window and no approvals; it must not claim a
// stalled watchdog fired. A running task with no sessionId settles honestly.
const stranded = getTask('fasta-only')!
stranded.status = 'running'
stranded.error = undefined
await reattachRunningTasks(null as never)
ok(
  'reattach without a session explains itself',
  stranded.status === 'failed' && !!stranded.error,
  `${stranded.status} / ${stranded.error}`,
)
ok('reattach does not invent a watchdog stall', !stranded.error?.includes('STALL_WATCHDOG'), stranded.error)

console.log(fails.length ? `\ntask reason unit: ${fails.length} FAILURES` : '\ntask reason unit: PASS')
process.exit(fails.length ? 1 : 0)
