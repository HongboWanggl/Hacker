// Render smoke test for the CompareCard path (compare_alphafold results).
import { Window } from '/Users/wanghanbao/agnes-harness/node_modules/.pnpm/happy-dom@20.14.3/node_modules/happy-dom/lib/index.js'
const win = new Window()
globalThis.window = win
globalThis.document = win.document
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(16), 16)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.devicePixelRatio = 1

const React = (await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')).default
const { renderToString } = await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/server.js')

const report = {
  accession: 'P04637', model: 'AF-P04637-F1 (v6)',
  alphafold: { residues: 393, meanPlddt: 75.1, dbMeanPlddt: 75.06, modelDate: '2025-08-01', savedTo: 'structures/P04637_alphafold_ref.pdb' },
  prediction: { path: 'structures/p53.pdb', residues: 393, meanPlddt: 80.3 },
  compared: {
    overlappingResidues: 393, meanAbsPlddtDelta: 11.1,
    largestDeltas: [{ residue: 3, delta: 45.2 }, { residue: 1, delta: 44.3 }],
    deltaSeries: [{ residue: 1, delta: 40.1 }, { residue: 40, delta: 12.2 }, { residue: 80, delta: -3.1 }, { residue: 120, delta: 2.4 }],
    deltaSeriesNote: 'ΔpLDDT profile (prediction − reference), ≤80 bins; positive = ESMFold more confident',
    caRmsd: 21.009, caRmsdCore: 9.773, coreResidues: 225,
    superposition: { q: [0.9659, 0.0692, 0.1383, 0.2075], pc: [1.1, 2.2, 3.3], qc: [0, 0, 0] },
    coreNote: 'RMSD over residues where both models have pLDDT ≥ 70',
    verdict: 'significant deviation (CA-RMSD > 4 Å); inspect the low-confidence regions',
  },
}

const mod = await import('/tmp/pv-client-test/index.js')
const services = { call: async () => { throw new Error('should not be called for compare') } }
const ctx = { slots: { registrations: [], register(def, comp) { this.registrations.push({ def, comp }) }, spec: () => ({ kind: 'keyed' }), entriesOfSlot() { return this.registrations.map((r) => ({ options: r.def })) }, subscribeDeclaration: () => () => {} }, agnes: { services }, effect: (f) => { const off = f(); return typeof off === 'function' ? off : undefined } }
mod.apply(ctx)
const regs = ctx.slots.registrations
console.log('registered:', regs.map((r) => r.def.key).join(', '))
if (regs.length !== 7) throw new Error('expected 7 registrations incl. batch_predict + compare_structures + uniprot_search')

const compareReg = regs.find((r) => r.def.key === 'compare_alphafold')
const html = renderToString(React.createElement(compareReg.comp, { owner: { callId: 't1-c', toolName: 'compare_alphafold', block: { resultPreview: JSON.stringify(report) } } }))
const checks = [
  ['score card (核心 RMSD)', html.includes('核心 RMSD') && html.includes('9.8')],
  ['full-chain chip', html.includes('CA-RMSD 全链') && html.includes('21.01 Å')],
  ['core chip', html.includes('9.77 Å')],
  ['delta chips', html.includes('#3') && html.includes('Δ+45.2')],
  ['bars', html.includes('预测 (ESMFold)') && html.includes('AlphaFold DB')],
  ['no 3D mount for compare', !html.includes('pv-3d-col')],
  ['verdict line', html.includes('significant deviation')],
  ['sparkline bars', html.includes('pv-delta-bars') && (html.match(/pv-delta-bar /g) ?? []).length === 4],
  ['sparkline legend', html.includes('预测 (ESMFold) 更自信') && html.includes('AlphaFold DB 更自信')],
  ['compare3d loading state in SSR', html.includes('加载结构…')],
]
let failed = 0
for (const [name, ok] of checks) { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }
// confidence tools must still render the old panel
const confReg = regs.find((r) => r.def.key === 'predict_structure')
const confHtml = renderToString(React.createElement(confReg.comp, { owner: { callId: 't1-p', toolName: 'predict_structure', block: { resultPreview: JSON.stringify({ residues: 393, meanPlddt: 80.3, bands: {}, lowConfidenceSegments: [{ residues: '27-60', length: 34, meanPlddt: 56.1 }], savedTo: 'structures/p53.pdb' }) } } }))
console.log(confHtml.includes('平均 pLDDT') ? 'ok ' : 'FAIL', 'confidence path unchanged')
console.log(confHtml.includes('pv-loading') ? 'ok ' : 'FAIL', 'confidence SSR shows loading (toolbar is client-only)')
if (failed) throw new Error(`${failed} checks failed`)
// Boltz-2 complex report: headline score = bindingConfidence, no band bar.
const complexReg = regs.find((r) => r.def.key === 'predict_complex')
const complexReport = {
  predictionId: 'pred_123', savedTo: 'structures/complex_boltz.pdb', chains: 2, hasLigand: true, residues: 210,
  structureConfidence: 84.2, ptm: 88.1, iptm: 82.5, ligandIptm: 79.9, proteinIptm: 83.4, bindingConfidence: 87.3,
  verdict: 'predicted to bind with high confidence', engine: 'boltz2-local', runtimeSec: 73,
}
const chtml = renderToString(React.createElement(complexReg.comp, { owner: { callId: 't1-x', toolName: 'predict_complex', block: { resultPreview: JSON.stringify(complexReport) } } }))
const cchecks = [
  ['complex score = bindingConfidence', chtml.includes('87.3') && chtml.includes('结合置信度')],
  ['complex verdict', chtml.includes('预测高置信结合')],
  ['chains + ligand', chtml.includes('2 链 + 配体')],
  ['metric chips', chtml.includes('ipTM') && chtml.includes('82.5')],
  ['local engine badge with runtime', chtml.includes('pv-engine-badge') && chtml.includes('本机引擎') && chtml.includes('73 秒')],
  ['no pLDDT band bar', !chtml.includes('pLDDT 置信度分布')],
  // renderToString does not run effects, so Compare3D stays in its loading state.
  ['3D deferred to client (SSR shows loading)', !chtml.includes('pv-3d-col') && chtml.includes('加载结构…')],
]
for (const [name, ok] of cchecks) { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }
// Ligand-free runs report ligand_iptm as 0.0 — the chip must stay hidden.
const noligHtml = renderToString(
  React.createElement(
    complexReg.comp,
    { owner: { callId: 't1-y', toolName: 'predict_complex', block: { resultPreview: JSON.stringify({ ...complexReport, hasLigand: false, ligandIptm: 0 }) } } },
  ),
)
console.log(noligHtml.includes('ligand ipTM') ? 'FAIL' : 'ok ', 'no ligand chip when ligand-free')
if (noligHtml.includes('ligand ipTM')) failed++
// Single protein + ligand: protein_iptm is 0.0 in real output — chip must stay hidden.
const singleHtml = renderToString(
  React.createElement(
    complexReg.comp,
    { owner: { callId: 't1-z', toolName: 'predict_complex', block: { resultPreview: JSON.stringify({ ...complexReport, chains: 1, proteinIptm: 0 }) } } },
  ),
)
console.log(singleHtml.includes('protein ipTM') ? 'FAIL' : 'ok ', 'no protein chip when single protein chain')
if (singleHtml.includes('protein ipTM')) failed++
// Boltz-2 local runs save a PAE matrix — the panel mounts the heatmap module.
// renderToString skips effects, so SSR shows the loading note; draw/hover are client-only.
const paeHtml = renderToString(
  React.createElement(
    complexReg.comp,
    { owner: { callId: 't1-pae', toolName: 'predict_complex', block: { resultPreview: JSON.stringify({ ...complexReport, paePath: 'structures/complex_boltz_pae.npz' }) } } },
  ),
)
console.log(paeHtml.includes('PAE 误差热图') && paeHtml.includes('加载 PAE 矩阵…') ? 'ok ' : 'FAIL', 'PAE module mounts when paePath present')
if (!(paeHtml.includes('PAE 误差热图') && paeHtml.includes('加载 PAE 矩阵…'))) failed++
console.log(chtml.includes('PAE 误差热图') ? 'FAIL' : 'ok ', 'PAE module absent without paePath')
if (chtml.includes('PAE 误差热图')) failed++
// batch_predict card
const batchReg = regs.find((r) => r.def.key === 'batch_predict')
const batchReport = {
  jobs: [
    { accession: 'P04637', name: 'Cellular tumor antigen p53', status: 'ok', savedTo: 'structures/P04637_393aa.pdb', residues: 393, meanPlddt: 80.3, lowSegments: 4, verdict: 'backbone mostly reliable' },
    { accession: 'P61626', name: 'Lysozyme C', status: 'ok', savedTo: 'structures/P61626_148aa.pdb', residues: 148, meanPlddt: 91.9, lowSegments: 1 },
    { accession: 'P99999', status: 'failed', error: 'UniProt fetch failed: HTTP 404' },
  ],
  summary: { total: 3, ok: 2, failed: 1, meanPlddt: 86.1 },
}
const bhtml = renderToString(React.createElement(batchReg.comp, { owner: { callId: 't1-b', toolName: 'batch_predict', block: { resultPreview: JSON.stringify(batchReport) } } }))
const bchecks = [
  ['batch count header', bhtml.includes('批处理蛋白') && bhtml.includes('>3<')],
  ['batch summary', bhtml.includes('2 成功') && bhtml.includes('1 失败')],
  ['batch mean chip', bhtml.includes('86.1')],
  ['batch rows', bhtml.includes('P04637') && bhtml.includes('Cellular tumor antigen p53') && bhtml.includes('393 残基')],
  ['batch low-seg note', bhtml.includes('4 低置信区段')],
  ['batch failed row', bhtml.includes('P99999') && bhtml.includes('HTTP 404')],
  ['batch score chips', bhtml.includes('80.3') && bhtml.includes('91.9')],
  ['batch csv export button', bhtml.includes('导出 CSV') && bhtml.includes('pv-export')],
  ['batch sort select', bhtml.includes('按 pLDDT 降序') && bhtml.includes('按残基数') && bhtml.includes('默认顺序')],
]
for (const [name, ok] of bchecks) { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }
// compare_structures: same card, generic labels from report.pairwise.labels
const pwReg = regs.find((r) => r.def.key === 'compare_structures')
const pwReport = {
  pairwise: { labels: ['p53_wt_393aa.pdb', 'p53_mut_393aa.pdb'] },
  prediction: { path: 'structures/p53_wt_393aa.pdb', residues: 393, meanPlddt: 80.3 },
  alphafold: { savedTo: 'structures/p53_mut_393aa.pdb', residues: 393, meanPlddt: 78.9 },
  compared: {
    overlappingResidues: 393, meanAbsPlddtDelta: 2.4,
    largestDeltas: [{ residue: 120, delta: -18.3 }],
    deltaSeries: [{ residue: 1, delta: 0.2 }, { residue: 40, delta: -1.1 }],
    deltaSeriesNote: '横轴按每 5 个残基分箱 · 正值=A 更自信，负值=B 更自信',
    caRmsd: 0.84, caRmsdCore: 0.31, coreResidues: 310,
    superposition: { q: [1, 0, 0, 0], pc: [0, 0, 0], qc: [0, 0, 0] },
    coreNote: '核心 RMSD 只统计两侧 pLDDT≥70 的 310 个共有残基',
    verdict: 'folds agree closely (CA-RMSD < 2 Å)',
  },
}
const phtml = renderToString(React.createElement(pwReg.comp, { owner: { callId: 't1-w', toolName: 'compare_structures', block: { resultPreview: JSON.stringify(pwReport) } } }))
const pchecks = [
  ['pairwise labels in verdict line', phtml.includes('p53_wt_393aa.pdb vs p53_mut_393aa.pdb')],
  ['pairwise bar labels', phtml.includes('p53_wt_393aa.pdb') && !phtml.includes('预测 (ESMFold)')],
  ['pairwise score card', phtml.includes('核心 RMSD') && phtml.includes('0.3')],
  ['pairwise chips', phtml.includes('CA-RMSD 全链') && phtml.includes('0.84 Å')],
  ['pairwise sparkline', phtml.includes('pv-delta-bars')],
  ['alphaflow wording absent', !phtml.includes('AlphaFold DB')],
]
for (const [name, ok] of pchecks) { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }
// uniprot_search hit table card
const searchReg = regs.find((r) => r.def.key === 'uniprot_search')
const searchReport = {
  query: 'gene:TP53 AND organism_id:9606',
  hits: [
    { accession: 'P04637', id: 'P53_HUMAN', proteinName: 'Cellular tumor antigen p53', organism: 'Homo sapiens', length: 393 },
    { accession: 'Q9NZJ0', id: 'P63_HUMAN', proteinName: 'Tumor protein 63', organism: 'Homo sapiens', length: 641 },
  ],
}
const shtml = renderToString(React.createElement(searchReg.comp, { owner: { callId: 't1-s', toolName: 'uniprot_search', block: { resultPreview: JSON.stringify(searchReport) } } }))
const schks = [
  ['search header with query', shtml.includes('UniProt 搜索') && shtml.includes('gene:TP53')],
  ['hit count', shtml.includes('>2<')],
  ['accession mono cells', shtml.includes('P04637') && shtml.includes('Q9NZJ0')],
  ['name + organism columns', shtml.includes('Cellular tumor antigen p53') && shtml.includes('Homo sapiens')],
  ['length column', shtml.includes('393 aa')],
  ['copy hint footer', shtml.includes('点击行复制 accession')],
  ['sortable header cells', shtml.includes('pv-search-head-cell') && shtml.includes('点击排序')],
  ['sort hint footer', shtml.includes('点击表头排序')],
  ['uniprot entry links', shtml.includes('uniprotkb/P04637') && shtml.includes('在 UniProt 网站打开')],
]
for (const [name, ok] of schks) { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }
// empty hits → friendly fallback, no table
const shtml2 = renderToString(React.createElement(searchReg.comp, { owner: { callId: 't1-s2', toolName: 'uniprot_search', block: { resultPreview: JSON.stringify({ query: 'zzz', hits: [] }) } } }))
console.log(shtml2.includes('没有匹配的蛋白') ? 'ok ' : 'FAIL', 'empty hits fallback')
if (!shtml2.includes('没有匹配的蛋白')) failed++
console.log('ALL COMPARE-CARD TESTS PASS')
process.exit(0)
