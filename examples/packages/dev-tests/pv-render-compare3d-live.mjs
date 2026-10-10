// Client-side render: Compare3D mounts 3D with ghost overlay when both structures load.
import { Window } from '/Users/wanghanbao/agnes-harness/node_modules/.pnpm/happy-dom@20.14.3/node_modules/happy-dom/lib/index.js'
const win = new Window()
globalThis.window = win
globalThis.document = win.document
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(16), 16)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.devicePixelRatio = 1
const anyFn = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : anyFn), apply: () => anyFn })
win.HTMLCanvasElement.prototype.getContext = function () { return anyFn }

const React = (await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')).default
const { createRoot } = await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js')

const mod = await import('/tmp/pv-client-test/index.js')
const mk = (n) => Array.from({ length: n }, (_, i) => ({ i: i + 1, aa: 'A', x: i * 3.8 - 40, y: Math.sin(i) * 5, z: Math.cos(i) * 5, b: 60 + i }))
const calls = []
const services = { call: async (name, input) => {
  calls.push(input.path)
  if (name !== 'protein.structure') throw new Error('unexpected ' + name)
  // reference model sits 5 pLDDT below the prediction → non-zero Δ in tooltips
  const res = mk(20).map((r) => (input.path.includes('alphafold_ref') ? { ...r, b: r.b - 5 } : r))
  return { n: 20, sequence: 'A'.repeat(20), residues: res }
} }
const report = {
  accession: 'P04637', model: 'AF-P04637-F1 (v6)',
  alphafold: { residues: 393, meanPlddt: 75.1, savedTo: 'structures/P04637_alphafold_ref.pdb' },
  prediction: { path: 'structures/p53.pdb', residues: 393, meanPlddt: 80.3 },
  compared: {
    overlappingResidues: 393, meanAbsPlddtDelta: 11.1, caRmsd: 21.009,
    largestDeltas: [{ residue: 3, delta: 45.2 }],
    deltaSeries: [{ residue: 1, delta: 40.1 }, { residue: 40, delta: 12.2 }, { residue: 80, delta: -3.1 }, { residue: 120, delta: 2.4 }],
    superposition: { q: [0.9659, 0.0692, 0.1383, 0.2075], pc: [1.1, 2.2, 3.3], qc: [0.4, 0.5, 0.6] },
    verdict: 'significant deviation (CA-RMSD > 4 Å)',
  },
}
const ctx = { slots: { registrations: [], register(def, comp) { this.registrations.push({ def, comp }) }, spec: () => ({ kind: 'keyed' }), entriesOfSlot() { return this.registrations.map((r) => ({ options: r.def })) }, subscribeDeclaration: () => () => {} }, agnes: { services }, effect: (f) => { const off = f(); return typeof off === 'function' ? off : undefined } }
mod.apply(ctx)
const comp = ctx.slots.registrations.find((r) => r.def.key === 'compare_alphafold').comp
const container = win.document.createElement('div')
win.document.body.appendChild(container)
createRoot(container).render(React.createElement(comp, { owner: { callId: 'c', toolName: 'compare_alphafold', block: { resultPreview: JSON.stringify(report) } }, services }))
await new Promise((r) => setTimeout(r, 400))
const html = container.innerHTML
const checks = [
  ['both structures requested', calls.includes('structures/p53.pdb') && calls.includes('structures/P04637_alphafold_ref.pdb')],
  ['3D title shows ghost count', html.includes('3D 叠合 · 预测 20 aa + 参考 20 aa')],
  ['ghost hint', html.includes('灰色为 AlphaFold 参考模型')],
  ['3D canvas mounted', html.includes('pv-3d')],
  ['3D floating tip mounted', html.includes('pv-3d-tip')],
  ['compare export button mounted', html.includes('导出 PNG')],
  ['compare CSV export button mounted', html.includes('导出 CSV')],
  ['copy-summary button mounted', html.includes('复制结论')],
  ['AlphaFold DB link mounted', html.includes('alphafold.ebi.ac.uk/entry/AF-P04637-F1')],
  ['sparkline still present', html.includes('pv-delta-bars')],
  ['divergence strip renders 20 tiles', (html.match(/pv-seq-tile/g) ?? []).length === 20],
  ['strip tile carries Δ tooltip', /· Δ -?\d/.test(html)],
  ['divergence legend mounted', html.includes('pv-divlegend') && html.includes('≥30')],
]
let failed = 0
for (const [name, ok] of checks) { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }

// strip mode toggle: switch to the Cα-distance lens — legend swaps, tiles
// recolor to the teal end of the distance ramp, tooltips carry the distance.
const modeBtns = [...container.querySelectorAll('.pv-stripmodes button')]
const distBtn = modeBtns.find((b) => (b.textContent ?? '').includes('Cα 偏差'))
checks.push(['strip mode toggle rendered (two chips)', modeBtns.length === 2 && modeBtns[0].textContent.includes('置信度差异')])
checks.push(['Cα-distance chip present', !!distBtn])
if (distBtn) {
  // The fixture's ghost is the prediction rotated away, so distances land
  // mid-ramp — assert recoloring as "backgrounds changed", not exact values.
  const bgBefore = [...container.querySelectorAll('.pv-seq-tile')].map((t) => t.getAttribute('style') ?? '')
  distBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 250))
  const html2 = container.innerHTML
  const bgAfter = [...container.querySelectorAll('.pv-seq-tile')].map((t) => t.getAttribute('style') ?? '')
  const changed = bgBefore.filter((s, i) => s !== bgAfter[i]).length
  checks.push(['distance legend swaps in', html2.includes('≥5 Å') && html2.includes('Cα 偏差')])
  checks.push(['tiles recolor to distance ramp', changed >= 5])
  checks.push(['tile tooltip carries Cα distance', /Cα \d+\.\d+ Å/.test(html2)])
  // back to the default lens so later assertions see the original strip
  modeBtns[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 250))
}
for (const [name, ok] of checks.slice(-((modeBtns.length === 2 && distBtn) ? 5 : 2))) { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }

// chip → strip sync: clicking the largest-delta chip outlines that residue's tile
const chip = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('Δ'))
if (chip) {
  chip.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 250))
  const sel = container.querySelector('.pv-seq-tile--sel')
  checks.push(['chip click outlines strip tile', !!sel && (sel.title ?? '').includes('A3')])
} else {
  checks.push(['largest-delta chip rendered', false])
}
for (const [name, ok] of checks.slice(checks.length - (chip ? 1 : 1))) { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }

// copy-summary: stub the clipboard, click 复制结论, inspect the markdown payload.
const clipTexts = []
try { Object.defineProperty(win.navigator, 'clipboard', { value: { writeText: (t) => clipTexts.push(t) }, configurable: true }) } catch {}
const copyBtn = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '复制结论')
checks.push(['copy button rendered in chips row', !!copyBtn])
if (copyBtn) {
  copyBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 200))
  const md = clipTexts.join('\n')
  checks.push(['copy payload: title + CA-RMSD', /结构对比：/.test(md) && /CA-RMSD 全链: 21\.01 Å/.test(md)])
  checks.push(['copy payload: mean delta + overlap', /平均 pLDDT 差: 11\.1/.test(md) && /重叠残基: 393/.test(md)])
  checks.push(['copy payload: verdict + top divergence', /结论: significant deviation/.test(md) && /#3 \(Δ\+45\.2\)/.test(md)])
  checks.push(['copy button confirms', (copyBtn.textContent ?? '').includes('已复制')])
}
for (const [name, ok] of checks.slice(copyBtn ? -5 : -1)) { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }
process.exit(failed ? 1 : 0)
