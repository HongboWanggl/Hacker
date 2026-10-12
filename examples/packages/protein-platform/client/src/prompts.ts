export type TaskType = 'single' | 'complex' | 'batch'

export type TaskInput = {
  sequence?: string
  accession?: string
  name?: string
  sequences?: string[] // complex: one per chain
  ligandSmiles?: string
  accessions?: string[] // batch
}

// Prompt templates are the product logic: strict, no-questions scripts so the
// agent just executes the pipeline and every tool lands a savedTo result.
export function buildPrompt(type: TaskType, input: TaskInput): string {
  const name = input.name?.trim() || 'structure'
  if (type === 'single') {
    const seq = input.accession
      ? `1) 调用 uniprot_fetch 获取 ${input.accession} 的正式序列
2) 调用 predict_structure 预测该序列（name: ${name}）
3) 调用 analyze_confidence 分析置信度并识别低置信区段
4) 用一句话给出结论。`
      : `1) 调用 predict_structure 预测以下序列（name: ${name}）
2) 调用 analyze_confidence 分析置信度并识别低置信区段
3) 用一句话给出结论。`
    return `预测蛋白质三维结构。严格按步骤执行，不要询问任何问题：
${seq}
${input.sequence ? `\n序列：\n${input.sequence.trim()}\n` : ''}`
  }
  if (type === 'complex') {
    const chains = (input.sequences ?? []).map((s, i) => `链 ${String.fromCharCode(65 + i)}: ${s.trim()}`).join('\n')
    return `预测蛋白质复合物结构。严格按步骤执行，不要询问任何问题：
1) 调用 predict_complex，chains 参数为各链序列（逗号分隔，按顺序对应 A、B…链）${input.ligandSmiles ? `，ligand_smiles 参数为 "${input.ligandSmiles.trim()}"` : ''}，name 参数为 ${name}
2) 完成后简要给出界面置信度结论。

${chains}
`
  }
  const accs = (input.accessions ?? []).join(', ')
  return `批量预测蛋白质结构。严格按步骤执行，不要询问任何问题：
1) 调用 batch_predict，accessions 参数为 [${accs}]
2) 用两三句话总结整体质量分布。`
}

export const TASK_TYPE_LABEL: Record<TaskType, string> = {
  single: '单体结构预测',
  complex: '复合物预测',
  batch: '批量预测',
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
