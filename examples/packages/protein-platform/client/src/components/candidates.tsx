import { useCallback, useMemo, useRef, useState } from 'react'
import { getServices } from '../bff.ts'
import { type CandidateHit, type LookupFailure, type LookupPhase, lookupCandidates } from '../lookup.ts'
import { MAX_BATCH_ACCESSIONS } from '../prompts.ts'
import { ToolViewStage } from './stage.tsx'

// The candidate panel: a description goes in, accessions come out, right under the
// box the user typed into. This replaces the old flow (submit → a 检索 task appears →
// open it from the task list → click a row → another task), which read as "the platform
// gave me nothing" and left an unopenable search row behind on every attempt.
//
// The table itself is protein-view's SearchCard, handed a parseable preview so it
// renders from data we already have — sortable headers, row checkboxes, per-row ▶
// and the batch bar all come from there. Single-select (▶) and multi-select (ticks +
// batch bar) are the same control surface, so the panel adds no interaction of its own.

export type LookupState =
  | { phase: 'idle' }
  | { phase: 'running'; query: string; stage: LookupPhase }
  | { phase: 'done'; query: string; hits: CandidateHit[]; source: 'fast' | 'agent'; total?: number }
  | { phase: 'failed'; query: string; reason: LookupFailure }

/** Owns the lookup lifecycle: one in flight at a time, cancellable, and settling to
 *  an honest state (never a spinner over an empty table). */
export function useCandidates(
  cfg: { tasksRoot: string } | undefined,
  // biome-ignore lint/suspicious/noExplicitAny: the DaemonLink handle passed down from boot()
  sdk: any,
) {
  const [state, setState] = useState<LookupState>({ phase: 'idle' })
  const inflight = useRef<AbortController | null>(null)

  const start = useCallback(
    (query: string) => {
      const q = query.trim()
      if (!q || !cfg || !sdk) return
      inflight.current?.abort()
      const ac = new AbortController()
      inflight.current = ac
      setState({ phase: 'running', query: q, stage: 'fast' })
      void lookupCandidates(cfg, sdk, q, {
        signal: ac.signal,
        onPhase: (stage) => setState((s) => (s.phase === 'running' && s.query === q ? { ...s, stage } : s)),
      }).then((res) => {
        if (ac.signal.aborted) return
        inflight.current = null
        if (res.ok)
          setState({ phase: 'done', query: q, hits: res.hits, source: res.source, total: res.total })
        else if (res.reason === 'cancelled') setState({ phase: 'idle' })
        else setState({ phase: 'failed', query: q, reason: res.reason })
      })
    },
    [cfg, sdk],
  )

  const reset = useCallback(() => {
    inflight.current?.abort()
    inflight.current = null
    setState({ phase: 'idle' })
  }, [])

  return { state, start, reset }
}

const FAILURE_TEXT: Record<LookupFailure, string> = {
  'no-hits':
    '没有找到匹配的蛋白。试试「蛋白名 / 基因名 + 物种」（如 hemoglobin human），或直接粘贴序列 / UniProt ID。',
  timeout: '检索超时（45 秒）。可直接输入 UniProt ID 或粘贴序列预测。',
  cancelled: '',
  http: 'UniProt 检索服务暂时不可用，稍后重试即可；也可直接输入 UniProt ID 或粘贴序列。',
  network: '连不上 UniProt 检索服务，稍后重试即可；也可直接输入 UniProt ID 或粘贴序列。',
  internal: '检索过程出错，稍后重试即可；也可直接输入 UniProt ID 或粘贴序列。',
}

const STAGE_TEXT: Record<LookupPhase, string> = {
  fast: '正在检索 UniProt…',
  agent: '正在理解你的描述并检索候选…（约 10–20 秒）',
  reading: '正在读取候选列表…',
}

export function CandidatePanel({
  state,
  onClose,
  name,
  cfg,
  sdk,
}: {
  state: LookupState
  onClose: () => void
  name?: string
  cfg?: { tasksRoot: string }
  // biome-ignore lint/suspicious/noExplicitAny: see above
  sdk?: any
}) {
  // >8 selections are refused rather than silently trimmed: batch_predict hard-fails
  // above 8, and dropping targets the user explicitly ticked is their decision to make.
  const [overflow, setOverflow] = useState<number | null>(null)

  const handlePredict = useCallback(
    (accs: string[]) => {
      if (!cfg || !sdk || accs.length === 0) return
      if (accs.length > MAX_BATCH_ACCESSIONS) {
        setOverflow(accs.length)
        return
      }
      setOverflow(null)
      void (async () => {
        try {
          const { runTask } = await import('../orchestrator.ts')
          if (accs.length === 1) {
            await runTask(cfg, sdk, 'single', { accession: accs[0], ...(name ? { name } : {}) })
          } else {
            await runTask(cfg, sdk, 'batch', { accessions: accs })
          }
          onClose()
          location.hash = '#/tasks'
        } catch (e) {
          console.warn('[platform] candidate hand-off failed:', (e as Error)?.message)
        }
      })()
    },
    [cfg, sdk, name, onClose],
  )

  // SearchCard reads its report from this string; a fresh object per render would
  // remount the table (and its selection) on every keystroke elsewhere on the page.
  const preview = useMemo(
    () => (state.phase === 'done' ? JSON.stringify({ query: state.query, hits: state.hits }) : ''),
    [state],
  )

  if (state.phase === 'idle') return null

  if (state.phase === 'running') {
    return (
      <div className="pl-candidates" aria-live="polite">
        <div className="pl-candidates-head">
          <span className="pl-spinner" />
          <span className="pl-candidates-title">{STAGE_TEXT[state.stage]}</span>
          <button type="button" className="pl-back" onClick={onClose}>
            取消
          </button>
        </div>
        <div className="pl-candidates-sub">「{state.query}」</div>
      </div>
    )
  }

  if (state.phase === 'failed') {
    return (
      <div className="pl-candidates" aria-live="polite">
        <div className="pl-candidates-head">
          <span className="pl-candidates-title">未找到候选</span>
          <button type="button" className="pl-back" onClick={onClose}>
            收起
          </button>
        </div>
        <div className="pl-candidates-sub">{FAILURE_TEXT[state.reason]}</div>
      </div>
    )
  }

  return (
    <div className="pl-candidates" aria-live="polite">
      <div className="pl-candidates-head">
        <span className="pl-candidates-title">
          候选蛋白 · {state.hits.length} 条
          {typeof state.total === 'number' && state.total > state.hits.length
            ? `（共 ${state.total} 条匹配）`
            : ''}
        </span>
        <button type="button" className="pl-back" onClick={onClose}>
          收起
        </button>
      </div>
      <div className="pl-candidates-sub">
        点行尾 <b>▶</b> 直接预测该条；勾选多行后点表格下方的「▶ 批量预测所选（N）」一次预测多个。
        {state.source === 'agent' ? '（候选由平台理解你的描述后检索得到）' : ''}
      </div>
      {overflow !== null && (
        <div className="pl-callout">
          已选 {overflow} 个，一次最多 {MAX_BATCH_ACCESSIONS} 个：请取消勾选到 {MAX_BATCH_ACCESSIONS}{' '}
          个以内再点「批量预测所选」。
        </div>
      )}
      <ToolViewStage
        toolName="uniprot_search"
        savedTo="lookup"
        services={getServices()}
        preview={preview}
        onPredict={handlePredict}
      />
    </div>
  )
}
