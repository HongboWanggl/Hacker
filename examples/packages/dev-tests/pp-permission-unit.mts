// Unit pin for the two defects behind the 2026-10-15 Q02388 incident:
//
//   AGH_HOME=... AGNES_PROFILE=local-dev node --import tsx pp-permission-unit.mts
//
// 1. The platform auto-rejected EVERY approval it was asked for. The handler
//    called `session.answer(...)`, which does not exist, so PermissionGate
//    swallowed a TypeError and fell back to rejectPermission. These cases pin
//    the decision function on its own; the SDK's own PermissionGate is driven
//    below with a stub request so "the return value is the answer" is proven
//    against the real code path, not just against our helper.
// 2. Both user-visible failure reasons were useless: `turn blocked` (no tool,
//    no cause) and `This operation was aborted` (hiding the watchdog, and
//    unretryable because it matches nothing in TRANSIENT_RE).

import { PermissionGate, rejectPermission } from '../../../packages/sdk/src/permission.ts'
import {
  describeApproval,
  permissionOutcome,
  turnFailureReason,
} from '../protein-platform/client/src/orchestrator.ts'
import { isTransientError } from '../protein-platform/client/src/transient.ts'

const fails: string[] = []
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(cond ? 'ok  ' : 'FAIL', name, extra)
  if (!cond) fails.push(name)
}
const eq = (name: string, got: unknown, want: unknown) =>
  ok(name, JSON.stringify(got) === JSON.stringify(want), `got=${JSON.stringify(got)}`)

const opt = (optionId: string, kind: string, name = optionId) => ({ optionId, kind, name })

// --- permissionOutcome: what we answer ---------------------------------------
eq(
  'allow_once is preferred',
  permissionOutcome({ options: [opt('a1', 'allow_once'), opt('al', 'allow_always')] }),
  {
    optionId: 'a1',
  },
)
eq(
  'allow_always is the fallback',
  permissionOutcome({ options: [opt('al', 'allow_always'), opt('r', 'reject_once')] }),
  {
    optionId: 'al',
  },
)
// A daemon that names its options unconventionally still gets a yes when the id
// clearly reads as one — this is the Boltz/predict_structure shape.
eq('id-based fallback', permissionOutcome({ options: [opt('proceed!', ''), opt('nope', '')] }), {
  optionId: 'proceed!',
})
// Nothing permissive on offer: reject honestly rather than invent an id.
eq('no allow option → rejected', permissionOutcome({ options: [opt('r', 'reject_once')] }), {
  verdict: 'rejected',
})
eq('no options at all → rejected', permissionOutcome({ options: [] }), { verdict: 'rejected' })
eq('missing request → rejected, never throws', permissionOutcome(undefined), { verdict: 'rejected' })
eq('garbage options → rejected, never throws', permissionOutcome({ options: [null, 7, {}] }), {
  verdict: 'rejected',
})
// A hostile id equal to an Object.prototype member must not be treated as a hit.
ok(
  'prototype keys are not options',
  JSON.stringify(permissionOutcome({ options: [opt('constructor', '')] })) ===
    JSON.stringify({ verdict: 'rejected' }),
)

// --- the real gate: the return value IS the answer ---------------------------
// This is the regression itself. Before the fix the handler answered via a
// method that does not exist; the gate must now see a selection, not `rejected`.
const gate = new PermissionGate()
gate.register(async (req) => permissionOutcome({ options: req.options }))
const request = {
  sessionId: 's1',
  toolCall: { title: 'predict_structure' },
  options: [opt('allow-once', 'allow_once', '允许一次'), opt('reject-once', 'reject_once', '拒绝')],
}
const answered = await gate.answer(request)
eq('gate selects the allow option', answered.outcome, { outcome: 'selected', optionId: 'allow-once' })
ok(
  'gate answer is NOT the fallback reject',
  JSON.stringify(answered) !== JSON.stringify(rejectPermission(request)),
)
// And a handler that throws is still a rejection — the old failure mode, kept
// here so the fix is understood as "our handler no longer throws", not "the SDK
// changed".
const throwing = new PermissionGate()
throwing.register(async () => {
  throw new TypeError('session.answer is not a function')
})
eq('a throwing handler still rejects (documented old behaviour)', (await throwing.answer(request)).outcome, {
  outcome: 'selected',
  optionId: 'reject-once',
})

// --- describeApproval: the reason can name its tool --------------------------
const opts = [opt('allow-once', 'allow_once', '允许一次'), opt('reject-once', 'reject_once', '拒绝')]
ok(
  'approval names the tool and the answer',
  describeApproval({ toolCall: { title: 'predict_structure' } }, opts, { optionId: 'allow-once' }) ===
    'predict_structure → 允许一次',
  describeApproval({ toolCall: { title: 'predict_structure' } }, opts, { optionId: 'allow-once' }),
)
ok(
  'approval falls back through label keys',
  describeApproval({ toolCall: { name: 'shell' } }, opts, { verdict: 'rejected' }) === 'shell → 拒绝',
)
ok(
  'approval survives a bare request',
  describeApproval(undefined, opts, { verdict: 'rejected' }) === '未知工具 → 拒绝',
)

// --- turnFailureReason: no more useless reasons ------------------------------
const blocked = turnFailureReason({ reason: 'blocked' }, { approvals: ['predict_structure → 拒绝'] })
ok('blocked names the tool', blocked.includes('predict_structure'), blocked)
ok('blocked is not the bare literal', blocked !== 'turn blocked')
ok('blocked stays retryable', isTransientError(blocked), blocked)
ok(
  'blocked with no recorded request still says something',
  turnFailureReason({ reason: 'blocked' }).includes('未获平台放行'),
)

const stalled = turnFailureReason({ reason: 'aborted', error: { message: 'This operation was aborted' } })
ok('aborted → watchdog text, not "This operation was aborted"', stalled.startsWith('STALL_WATCHDOG'), stalled)
ok('the watchdog window is quoted', stalled.includes('180s'), stalled)
ok(
  'a widened window is quoted too',
  turnFailureReason({ reason: 'aborted' }, { stallMs: 1_400_000 }).includes('1400s'),
)
// The retry gate is the whole point: the old wording matched nothing.
ok('the old wording was unretryable', !isTransientError('This operation was aborted'))
ok('the new wording retries', isTransientError(stalled), stalled)
ok(
  'reason blocked wins over an abort message',
  turnFailureReason(
    { reason: 'blocked', error: { message: 'aborted' } },
    { approvals: ['x → 拒绝'] },
  ).includes('审批'),
)
// Anything else keeps whatever the daemon said — do not invent a cause.
ok(
  'an unknown reason passes the daemon message through',
  turnFailureReason({ reason: 'error', error: { message: 'boom' } }) === 'boom',
)
ok(
  'an unknown reason with no message is still readable',
  turnFailureReason({ reason: 'error' }).includes('error'),
)

console.log(fails.length ? `\npermission unit: ${fails.length} FAILURES` : '\npermission unit: PASS')
process.exit(fails.length ? 1 : 0)
