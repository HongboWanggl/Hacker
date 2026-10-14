// E2E: drive one real single-sequence prediction exactly as the platform SPA does.
import { createClient, memoryJournal } from '../../../packages/sdk/src/index.node.ts'

const taskDir = `${process.env.AGH_HOME}/protein-platform/tasks/e2e-smoke-3`
const client = createClient({
  transport: { kind: 'unix', path: `${process.env.AGH_HOME}/data/daemon/agnesd.sock` },
  auth: { kind: 'local' },
  journal: memoryJournal(),
})
await client.initialize()
// biome-ignore lint/suspicious/noExplicitAny: probe drives the raw client surface, which is untyped by design here
await (client as any).workspace.add(taskDir)
// biome-ignore lint/suspicious/noExplicitAny: same raw client surface, see above
const session = await (client as any).session.new({ cwd: taskDir, preset: 'standard' })
const stages: { name: string; status: string }[] = []
let savedTo: string | undefined
let previewTail = ''
session.onPreview?.((d: { delta?: string }) => {
  previewTail = (previewTail + (d.delta ?? '')).slice(-300)
})
const events = session.events({ preview: false })
const loop = (async () => {
  for await (const row of events) {
    const env = row as unknown as { type: string; data?: Record<string, unknown> }
    const e = (env.data ?? env) as unknown as {
      name?: string
      isError?: boolean
      content?: { text?: string }[]
    }
    if (env.type === 'tool/call') stages.push({ name: e.name, status: 'running' })
    if (env.type === 'tool/result') {
      for (let i = stages.length - 1; i >= 0; i--)
        if (stages[i].status === 'running') {
          stages[i].status = e.isError ? 'error' : 'done'
          break
        }
      const text = (e.content ?? []).map((c: { text?: string }) => c.text ?? '').join('')
      const m = text.match(/"savedTo"\s*:\s*"((?:[^"\\]|\\.)*)"/)
      if (m) savedTo ??= m[1]
    }
    if (env.type === 'turn/end') return
  }
})()
const prompt = [
  '预测以下蛋白质的三维结构并分析置信度。全程不要向我提问，不要请求任何确认，直接执行所有工具调用。',
  '目标蛋白：UniProt P69905（HBA_HUMAN）。',
  '步骤：uniprot_fetch 获取 P69905 序列 → predict_structure 折叠预测 → analyze_confidence 置信度分析。',
  '完成后给出 savedTo 路径的 JSON 总结。',
].join('\n')
await session.prompt(prompt, {})
await loop
console.log('stages:', stages.map((s) => `${s.name}:${s.status}`).join(' '))
console.log('savedTo:', savedTo)
console.log('previewTail:', JSON.stringify(previewTail.slice(-160)))
process.exit(0)
