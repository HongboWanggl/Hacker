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
  /STALL_WATCHDOG|TRANSPORT|TURN_ERROR|turn (abort|blocked)|审批请求未获|status=\?|事件流中断|ECONN|EAI_AGAIN|EPIPE|socket hang up|fetch failed|reset|task dir: HTTP 5|HTTP 5\d\d|HTTP 429|status[ :=]5\d\d|code 5\d\d|rate.?limit|overloaded|E_SERVICE|busy|会话在后台中断|重连会话事件流失败|INTERNAL_ERROR \(-32603\)|守护进程在工具执行中|工具结果未知|回合被挂起|unknown-outcome|no_approver/i

/** Turn the daemon's wire codes into a sentence a user can act on.
 *
 *  A daemon restart during a tool call surfaces on the client as a JSON-RPC
 *  rejection whose message is the CODE ALONE — `INTERNAL_ERROR (-32603)`. That
 *  literal reached a wall card (ui3-under-ceiling-920, 2026-10-15: the daemon was
 *  restarted while a 10-minute fold was in flight, the turn parked, and the card
 *  said nothing but the number). The code names no cause and offers no next step.
 *
 *  Returns undefined for anything it does not recognise, so callers can keep the
 *  original text rather than lose information to a bad guess. */
export function explainDaemonError(text: string | undefined | null): string | undefined {
  if (typeof text !== 'string' || !text) return undefined
  if (/INTERNAL_ERROR\s*\(-32603\)/.test(text))
    return (
      '会话与守护进程的调用被中断（INTERNAL_ERROR -32603）：通常是守护进程在工具执行中重启，' +
      '本次工具是否完成无法确认。可重试 —— 重试会开一个新会话重跑。'
    )
  const unknown = /outcome of ([\w_]+) is unknown/i.exec(text)
  if (unknown || /unknown-outcome/i.test(text))
    return (
      `工具结果未知：守护进程在工具执行中退出，未能确认 ${unknown?.[1] ?? '这次工具调用'} 是否跑完` +
      '（它可能已经写出了结果，也可能没有）。可重试 —— 重试会开一个新会话重跑。'
    )
  if (/parked/.test(text))
    return '回合被挂起（parked）：守护进程需要一次人工确认（工具结果未知）但当时没有可用的审批方，回合无法继续。可重试。'
  return undefined
}

export function isTransientError(text: string | undefined | null): boolean {
  return typeof text === 'string' && TRANSIENT_RE.test(text)
}

/**
 * The retry checkpoint, as a pure function.
 *
 * It lives here (rather than inline in the run loop) because one of its inputs is
 * easy to get wrong in a way nothing else notices: **`userCancelled` must mean
 * "the user asked to stop", not "the abort signal is up"**. The stall watchdog
 * aborts the attempt it is watching, so a signal-based test silently vetoes the
 * retry for exactly the hung-gateway failure the watchdog exists to catch — and
 * the task then settles as failed instead of being resubmitted. That bug shipped
 * (2026-10-15: a 209 s stalled inference, aborted at 180 s, never retried); the
 * unit test drives both spellings so it cannot come back.
 */
export function shouldRetryAttempt(opts: {
  /** 1-based; the attempt that just finished. */
  attempt: number
  maxAttempts: number
  /** True only for a user-requested cancel. */
  userCancelled: boolean
  status?: string
  /** A partial result beats re-rolling: never wipe a produced artifact. */
  hasProductArtifact: boolean
  /** The cause (first tool error). */
  error?: string
  /** The newest symptom. */
  lastError?: string
}): boolean {
  return (
    opts.attempt < opts.maxAttempts &&
    !opts.userCancelled &&
    opts.status === 'failed' &&
    !opts.hasProductArtifact &&
    (isTransientError(opts.error) || isTransientError(opts.lastError))
  )
}
