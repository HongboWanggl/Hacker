// End-to-end on a live deployment (VPS daemon + home GPU worker over the
// tunnel): EVERY way a long chain can enter the platform must end with an
// explicit, user-visible reason. The 2026-10-15 Q02388 (2944 aa COL7A1)
// incident was the opposite: the agent burned the full 20-minute worker cap,
// the tool error was swallowed, and the row still read 「已完成」 with nothing
// behind it. This probe is the regression net for that.
//
//   AGH_HOME=... AGNES_PROFILE=local-dev node --import tsx pp-longchain-e2e.mts [caseId ...]
//
// Refusal cases (c1/c2/c3/c6) must come back FAST with the ceiling named and
// must leave no structure behind; fold cases (c4/c5) are real GPU runs that
// must actually produce a PDB — they prove the ceiling is not a blanket ban.
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createClient, memoryJournal } from '../../../packages/sdk/src/index.node.ts'
// The prompt is imported from the product, not copied: a probe that drifts
// from what users actually submit stops being evidence.
import { buildPrompt, type TaskInput, type TaskType } from '../protein-platform/client/src/prompts.ts'

const REFUSAL_TIMEOUT_MS = 4 * 60_000
const FOLD_TIMEOUT_MS = 22 * 60_000

// A low-complexity repeat is fine for refusal cases (they never reach a
// folder); nothing here should ever be sent to the GPU.
const syn = (n: number) => 'MKTAYIAKQRQISFVKSHFSRQ'.repeat(Math.ceil(n / 22)).slice(0, n)

type Case = {
  id: string
  why: string
  type: TaskType
  input: TaskInput
  kind: 'refusal' | 'fold'
  // For refusals: the tool failure has to name the ceiling and the way out.
  want?: RegExp[]
}

const CASES: Case[] = [
  {
    id: 'c1-uniprot-2944',
    why: '事故复现：Q02388 COL7A1 2944 aa，经 UniProt 取序列',
    type: 'single',
    input: { accession: 'Q02388', name: 'col7a1' },
    kind: 'refusal',
    want: [/1000/, /(split into domains|拆|结构域)/i],
  },
  {
    id: 'c2-pasted-2944',
    why: '粘贴超长序列 2944 aa（不经 UniProt）',
    type: 'single',
    input: { sequence: syn(2944), name: 'pasted_long' },
    kind: 'refusal',
    want: [/1000/, /(split into domains|拆|结构域)/i],
  },
  {
    id: 'c3-complex-1400',
    why: '复合物两条链共 1400 aa（每链 700，均未超单链感知限度）',
    type: 'complex',
    input: { sequences: [syn(700), syn(700)], name: 'pair_1400' },
    kind: 'refusal',
    want: [/1000/, /(1400|total|合计|链)/i],
  },
  {
    id: 'c6-just-over-1014',
    why: '边界：PARP1 P09874 恰好 1014 aa —— 差一点就超限',
    type: 'single',
    input: { accession: 'P09874', name: 'parp1' },
    kind: 'refusal',
    want: [/1000/],
  },
  {
    id: 'c4-under-ceiling-920',
    why: '天花板之下：雄激素受体 P10275 920 aa，应真的折叠出结构',
    type: 'single',
    input: { accession: 'P10275', name: 'ar_920' },
    kind: 'fold',
  },
  {
    id: 'c5-esmfold-wall-622',
    why: 'ESMFold 墙：凝血酶 P00734 622 aa → 预期 413 后换档 predict_complex',
    type: 'single',
    input: { accession: 'P00734', name: 'thrombin_622' },
    kind: 'fold',
  },
]

const want = process.argv.slice(2)
const selected = want.length ? CASES.filter((c) => want.includes(c.id)) : CASES
if (!selected.length) {
  console.error(`no such case. known: ${CASES.map((c) => c.id).join(', ')}`)
  process.exit(2)
}

const client = createClient({
  transport: { kind: 'unix', path: `${process.env.AGH_HOME}/data/daemon/agnesd.sock` },
  auth: { kind: 'local' },
  journal: memoryJournal(),
})
await client.initialize()

type ToolCall = { name: string; args: string; result?: { isError: boolean; text: string }; ms?: number }
const fails: string[] = []
const warns: string[] = []

const listStructures = (dir: string) => {
  try {
    return readdirSync(join(dir, 'structures')).filter((f) => f.endsWith('.pdb'))
  } catch {
    return []
  }
}

async function runCase(c: Case) {
  const taskDir = `${process.env.AGH_HOME}/protein-platform/tasks/pplc-${c.id}-${Date.now()}`
  mkdirSync(taskDir, { recursive: true })
  // biome-ignore lint/suspicious/noExplicitAny: raw client surface, untyped by design (see pp-e2e-task.mts)
  const anyClient = client as any
  await anyClient.workspace.add(taskDir)
  const session = await anyClient.session.new({ cwd: taskDir, preset: 'standard' })

  const calls: ToolCall[] = []
  const byId = new Map<string, ToolCall>()
  const resultTexts: string[] = []
  let finalText = ''
  let endReason: string | undefined
  let cancelled = false

  const events = session.events({ preview: false })
  const loop = (async () => {
    for await (const row of events) {
      const env = row as unknown as { type: string; ts?: number; data?: Record<string, unknown> }
      const d = (env.data ?? env) as unknown as {
        name?: string
        args?: unknown
        toolUseId?: string
        isError?: boolean
        content?: { type?: string; text?: string }[]
        reason?: string
      }
      const text = (d.content ?? []).map((b) => b.text ?? '').join('')
      if (env.type === 'tool/call') {
        const call: ToolCall = { name: d.name ?? '?', args: JSON.stringify(d.args ?? {}) }
        calls.push(call)
        if (d.toolUseId) byId.set(d.toolUseId, call)
      }
      if (env.type === 'tool/result') {
        resultTexts.push(text)
        const call = d.toolUseId ? byId.get(d.toolUseId) : calls.filter((x) => !x.result).at(-1)
        if (call) call.result = { isError: !!d.isError, text }
      }
      if (env.type === 'assistant/message') {
        const t = (d.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('')
        if (t.trim()) finalText = t
      }
      if (env.type === 'turn/end') {
        endReason = d.reason
        return
      }
    }
  })()

  const limit = c.kind === 'refusal' ? REFUSAL_TIMEOUT_MS : FOLD_TIMEOUT_MS
  const ac = new AbortController()
  const guard = setTimeout(() => {
    cancelled = true
    console.log(`  !! exceeded ${Math.round(limit / 60000)} min — cancelling the turn`)
    ac.abort()
    // Aborting the prompt signal stops *our* wait; cancel() stops the turn
    // daemon-side, which is what actually frees the GPU for the next case.
    void session.cancel().catch(() => undefined)
  }, limit)

  const t0 = Date.now()
  await session.prompt(buildPrompt(c.type, c.input), { signal: ac.signal }).catch(() => undefined)
  // A cancelled turn may never emit turn/end — do not let the probe hang on it.
  await Promise.race([loop, new Promise((r) => setTimeout(r, 20_000))])
  clearTimeout(guard)
  const turnMs = Date.now() - t0

  const toolLine = calls
    .map((x) => `${x.name}:${x.result ? (x.result.isError ? 'ERR' : 'ok') : 'NO-RESULT'}`)
    .join(' ')
  const pdbs = listStructures(taskDir)
  const dangling = calls.filter((x) => !x.result)
  const esmErr = resultTexts.find((t) => /ESMFold request failed: HTTP (413|422)/.test(t))
  const complexOk = calls.some((x) => x.name === 'predict_complex' && x.result && !x.result.isError)

  console.log(`\n=== ${c.id} — ${c.why}`)
  console.log(
    `  turn: ${endReason ?? 'NO turn/end'} in ${(turnMs / 1000).toFixed(1)}s${cancelled ? ' (CANCELLED)' : ''}`,
  )
  console.log(`  tools: ${toolLine || '(none)'}`)
  console.log(`  structures: ${pdbs.length ? pdbs.join(', ') : '(none)'}`)
  console.log(`  final: ${JSON.stringify(finalText.slice(0, 220))}`)

  // --- invariants that hold for every case -----------------------------------
  if (cancelled) fails.push(`${c.id}: 超出 ${Math.round(limit / 60000)} 分钟仍未结束（静默卡死）`)
  if (dangling.length)
    fails.push(
      `${c.id}: ${dangling.length} 次工具调用没有对应结果（${dangling.map((d) => d.name).join(',')}）`,
    )
  if (!endReason) fails.push(`${c.id}: 回合未正常结束`)
  if (!finalText.trim()) fails.push(`${c.id}: 最终回复为空 —— 用户看不到任何结论`)
  if (calls.some((x) => x.name === 'boltz')) warns.push(`${c.id}: agent 又臆造了不存在的工具名 boltz`)

  // --- refusal cases: fast, explicit, and nothing left behind ----------------
  if (c.kind === 'refusal') {
    if (turnMs > 120_000)
      fails.push(`${c.id}: 拒绝用了 ${(turnMs / 1000).toFixed(0)}s，超过 2 分钟 —— 应秒拒`)
    const errtxt = resultTexts.filter(Boolean).join('\n')
    for (const re of c.want ?? [])
      if (!re.test(errtxt))
        fails.push(
          `${c.id}: 工具失败信息缺少 ${re} —— 用户不知道该怎么办\n     实际: ${errtxt.slice(0, 300)}`,
        )
    if (pdbs.length) fails.push(`${c.id}: 拒绝路径却写出了结构 ${pdbs.join(',')} —— 拒绝不彻底`)
    // The agent's own summary must not claim success.
    if (
      /(成功|已完成|预测完成|successful)/.test(finalText) &&
      !/(无法|不能|cannot|unable|未能|no structure|split)/i.test(finalText)
    )
      fails.push(`${c.id}: 最终回复像在宣称成功，但没有任何结构产出`)
  }

  // --- fold cases: the ceiling must not have become a blanket ban ------------
  if (c.kind === 'fold') {
    if (!pdbs.length) fails.push(`${c.id}: 未产出任何 PDB —— 天花板之下也不给折，能力被误伤`)
    if (esmErr && !complexOk) warns.push(`${c.id}: ESMFold 已 413，但没有看到成功的 predict_complex 换档`)
    if (!esmErr && calls.some((x) => x.name === 'predict_structure' && x.result && !x.result.isError))
      warns.push(
        `${c.id}: predict_structure 直接成功（ESMFold 没有拒绝 ${c.input.accession ?? c.input.name}）`,
      )
  }

  rmSync(taskDir, { recursive: true, force: true })
}

for (const c of selected) await runCase(c)

console.log('\n—— 警告 ——')
console.log(warns.length ? warns.map((w) => `  ~ ${w}`).join('\n') : '  （无）')
console.log('—— 失败 ——')
console.log(fails.length ? fails.map((f) => `  ✗ ${f}`).join('\n') : '  （无）')
console.log(fails.length ? `longchain e2e: ${fails.length} FAILURES` : 'longchain e2e: PASS')
process.exit(fails.length ? 1 : 0)
