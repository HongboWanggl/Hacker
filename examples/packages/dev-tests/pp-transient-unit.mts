// Unit contract for the auto-retry gate (client/src/transient.ts): what counts
// as a transient failure worth an automatic resubmit, and — just as important —
// what must NOT (deterministic failures retrying would burn compute or loop).
import { isTransientError, shouldRetryAttempt } from '../protein-platform/client/src/transient.ts'

let bad = 0
const expect = (label: string, got: boolean, want: boolean) => {
  if (got !== want) {
    bad++
    console.log(`MISMATCH ${label}: got ${got}, want ${want}`)
  } else {
    console.log(`ok ${label}`)
  }
}

// --- transient: must retry ---
expect('watchdog stall', isTransientError('STALL_WATCHDOG：超过 180s 无任何事件，会话已中止重试'), true)
expect('transport drop', isTransientError('TRANSPORT status=?'), true)
expect('turn aborted by gateway', isTransientError('turn abort'), true)
expect('event stream died', isTransientError('事件流中断：session ended'), true)
expect('conn reset', isTransientError('read ECONNRESET'), true)
expect('dns flake', isTransientError('getaddrinfo EAI_AGAIN api.example.com'), true)
expect('socket hang up', isTransientError('socket hang up'), true)
expect('fetch failed', isTransientError('TypeError: fetch failed'), true)
expect('task dir 503', isTransientError('task dir: HTTP 503'), true)
expect('bare HTTP 502', isTransientError('HTTP 502 Bad Gateway'), true)
expect('status 500 form', isTransientError('request failed, status 500'), true)
expect('http 429', isTransientError('HTTP 429 Too Many Requests'), true)
expect('rate limit text', isTransientError('Rate limit exceeded, slow down'), true)
expect('overloaded', isTransientError('overloaded_error from upstream'), true)
expect('E_SERVICE', isTransientError('E_SERVICE_DEF reverted'), true)
expect('worker busy', isTransientError('worker busy, try again later'), true)
expect(
  'reattach daemon loss',
  isTransientError('会话在后台中断且无完成事件（daemon 重启？）— 可重新提交'),
  true,
)
expect('reattach stream fail', isTransientError('重连会话事件流失败：socket closed'), true)

// --- deterministic: must NOT retry ---
expect('boltz 20min tool timeout', isTransientError('boltz predict timed out after 20m'), false)
expect('generic timeout', isTransientError('request timeout'), false)
expect('task dir 401', isTransientError('task dir: HTTP 401'), false)
expect('forbidden', isTransientError('HTTP 403 Forbidden'), false)
expect('no pdb in report', isTransientError('no PDB path in report'), false)
expect('bad sequence', isTransientError('invalid residue Z in sequence'), false)
expect('session gone', isTransientError('会话不存在（daemon 重启或已清理）：unknown session'), false)
expect('empty', isTransientError(''), false)
expect('undefined', isTransientError(undefined), false)

// --- the retry checkpoint itself ---------------------------------------------
// isTransientError alone was never enough: a marker that matches TRANSIENT_RE
// still needs a gate that lets the retry through. The 2026-10-15 regression was
// a veto from the wrong signal — the stall watchdog aborts the attempt, and the
// gate read that as "the user said stop".
const gate = (o: Partial<Parameters<typeof shouldRetryAttempt>[0]> = {}) =>
  shouldRetryAttempt({
    attempt: 1,
    maxAttempts: 3,
    userCancelled: false,
    status: 'failed',
    hasProductArtifact: false,
    ...o,
  })

expect('gate: a stalled attempt is retried', gate({ error: 'STALL_WATCHDOG：超过 180s 无任何事件' }), true)
expect('gate: a stall is not a user cancel', gate({ error: 'STALL_WATCHDOG：…', userCancelled: false }), true)
expect('gate: a user cancel is not retried', gate({ error: 'STALL_WATCHDOG：…', userCancelled: true }), false)
expect('gate: a transport drop is retried', gate({ error: 'TRANSPORT status=?' }), true)
expect(
  'gate: a transient symptom earns it too',
  gate({ error: 'no PDB in report', lastError: 'HTTP 502' }),
  true,
)
expect(
  'gate: the cause wins over a clean lastError',
  gate({ error: 'invalid residue Z', lastError: '' }),
  false,
)
expect(
  'gate: a produced artifact is never re-rolled',
  gate({ error: 'HTTP 502', hasProductArtifact: true }),
  false,
)
expect('gate: only failed tasks retry', gate({ error: 'HTTP 502', status: 'done' }), false)
expect('gate: cancelled rows do not retry', gate({ error: 'HTTP 502', status: 'cancelled' }), false)
expect('gate: attempt ceiling is respected', gate({ error: 'HTTP 502', attempt: 3 }), false)
expect('gate: the last allowed attempt retries', gate({ error: 'HTTP 502', attempt: 2 }), true)

if (bad) {
  console.log(`FAIL: ${bad} mismatch(es)`)
  process.exit(1)
}
console.log('transient-unit: PASS')
