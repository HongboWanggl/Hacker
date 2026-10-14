// One shared judgement: is this failure worth an automatic resubmit? Used by
// the live run loop's retry checkpoint — the fake-done classifier (turn ended
// "completed" with a tool error) feeds the same test through task.error, so
// tool-level transients (API 5xx, rate limits, worker busy) retry too.
//
// Deliberately NOT matched:
//   - generic "timeout"/"timed out" — a boltz 20-minute tool timeout is a
//     deterministic failure for the same input; retrying burns GPU for nothing.
//     Gateway hangs are covered by the stall watchdog's own STALL_WATCHDOG mark.
//   - HTTP 401/403, permission/package errors — deterministic, retry is noise.
//   - user cancellations — the retry gate only ever sees status 'failed'.
//
// Matched on purpose: a refused approval (审批请求未获…). The platform answers its
// own permission requests, so a `blocked` turn means the gate misfired rather
// than that a human said no — retrying is the right call.

const TRANSIENT_RE =
  /STALL_WATCHDOG|TRANSPORT|TURN_ERROR|turn (abort|blocked)|审批请求未获|status=\?|事件流中断|ECONN|EAI_AGAIN|EPIPE|socket hang up|fetch failed|reset|task dir: HTTP 5|HTTP 5\d\d|HTTP 429|status[ :=]5\d\d|code 5\d\d|rate.?limit|overloaded|E_SERVICE|busy|会话在后台中断|重连会话事件流失败/i

export function isTransientError(text: string | undefined | null): boolean {
  return typeof text === 'string' && TRANSIENT_RE.test(text)
}
