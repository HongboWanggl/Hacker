export type TaskType = 'single' | 'complex' | 'batch' | 'search' | 'compare'

export type TaskInput = {
  sequence?: string
  accession?: string
  name?: string
  sequences?: string[] // complex: one per chain
  ligandSmiles?: string
  accessions?: string[] // batch
  query?: string // search
  predictionPath?: string // compare: predicted PDB (workspace-relative)
}

/** batch_predict hard-fails above this many accessions — the batch tab, the
 *  candidate panel and the result page's hand-off all cap at the same number. */
export const MAX_BATCH_ACCESSIONS = 8

// Prompt templates are the product logic: strict, no-questions scripts so the
// agent just executes the pipeline and every tool lands a savedTo result.
export function buildPrompt(type: TaskType, input: TaskInput): string {
  if (type === 'compare') return comparePrompt(input)
  const name = input.name?.trim() || 'structure'
  // Note: a natural-language description no longer reaches a prediction branch.
  // home.tsx / search.tsx run the candidate lookup (lookup.ts) without starting
  // any task, so `query` only ever travels with type==='search' — and that task
  // type is now produced by nothing but the hidden fallback turn inside the
  // lookup itself. If a description ever gets routed to `single` again, this
  // prompt needs the search step added back or it asks for "以下序列" with
  // nothing attached.
  if (type === 'single') {
    const seq = input.accession
      ? `1) 调用 uniprot_fetch 获取 ${input.accession} 的正式序列
2) 调用 predict_structure 预测该序列（name: ${name}）
3) 调用 analyze_confidence 分析置信度并识别低置信区段
4) 用一句话给出结论。`
      : `1) 调用 predict_structure 预测以下序列（name: ${name}）
2) 调用 analyze_confidence 分析置信度并识别低置信区段
3) 用一句话给出结论。`
    // The length refusal is the one branch the numbered plan cannot survive:
    // predict_structure refuses ≥1000 aa, so there is no PDB, and step 3 then
    // fails on a path that was never written. Because the platform reports a
    // failed task with its FIRST tool error (rootError), that second failure used
    // to be the only thing the user saw — `Cannot read structures/Q02388.pdb` —
    // burying the real cause, the residue count and the ceiling, which the tool
    // had already stated perfectly. Stop at the refusal and say what it said.
    return `预测蛋白质三维结构。严格按步骤执行，不要询问任何问题：
${seq}
如果 predict_structure 因序列过长而拒绝（上限 1000 aa）：立即停止后续步骤，不要调用 analyze_confidence —— 结构并不存在，那只会产生一个与真实原因无关的报错。请直接复述工具给出的原因（含具体残基数与上限），并说明可走的路线：改用不超过 1000 aa 的单个结构域或片段重新提交。
${input.sequence ? `\n序列：\n${input.sequence.trim()}\n` : ''}`
  }
  if (type === 'complex') {
    const chains = (input.sequences ?? [])
      .map((s, i) => `链 ${String.fromCharCode(65 + i)}: ${s.trim()}`)
      .join('\n')
    return `预测蛋白质复合物结构。严格按步骤执行，不要询问任何问题：
1) 调用 predict_complex，chains 参数为各链序列（逗号分隔，按顺序对应 A、B…链）${input.ligandSmiles ? `，ligand_smiles 参数为 "${input.ligandSmiles.trim()}"` : ''}，name 参数为 ${name}
2) 完成后简要给出界面置信度结论。

${chains}
`
  }
  const accs = (input.accessions ?? []).join(', ')
  if (type === 'batch') {
    return `批量预测蛋白质结构。严格按步骤执行，不要询问任何问题：
1) 调用 batch_predict，accessions 参数为 [${accs}]
2) 用两三句话总结整体质量分布。`
  }
  return `检索 UniProt 蛋白质数据库。用户输入：「${(input.query ?? '').trim()}」——它可能是自然语言描述（中文或英文），也可能是检索词。严格按步骤执行，不要询问任何问题：
1) 把用户输入转成合适的检索词（基因名 / 蛋白名 / 物种），调用 uniprot_search（limit 8，可用 gene:、organism_id: 等字段语法，必要时换词多检几次）
2) 优先呈现 reviewed（Swiss-Prot）条目，列出前 5-8 条候选：accession、蛋白名、基因、物种、序列长度
3) 不要调用任何预测工具 —— 用户会从候选中选择后再预测。`
}

function comparePrompt(input: TaskInput): string {
  return `对比预测结构与 AlphaFold 数据库参考模型。严格按步骤执行，不要询问任何问题：
1) 调用 compare_alphafold，accession 参数为 "${input.accession}"，prediction_path 参数为 "${input.predictionPath}"，save_report 参数为 true
2) 用两三句话总结一致性结论（CA-RMSD、pLDDT 差异分布）。`
}

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  single: '单体结构预测',
  complex: '复合物预测',
  batch: '批量预测',
  search: 'UniProt 检索',
  compare: 'AlphaFold 对比',
}

export const STAGE_LABEL: Record<string, string> = {
  uniprot_search: 'UniProt 检索',
  uniprot_fetch: '获取 UniProt 记录',
  predict_structure: '结构预测（ESMFold）',
  predict_complex: '复合物预测（Boltz-2）',
  analyze_confidence: '置信度分析',
  compare_alphafold: '对比 AlphaFold 数据库',
  compare_structures: '结构两两对比',
  batch_predict: '批量预测',
}
