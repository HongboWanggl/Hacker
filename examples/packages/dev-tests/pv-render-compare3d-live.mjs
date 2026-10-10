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
  ['sparkline still present', html.includes('pv-delta-bars')],
  ['divergence strip renders 20 tiles', (html.match(/pv-seq-tile/g) ?? []).length === 20],
  ['strip tile carries Δ tooltip', /· Δ -?\d/.test(html)],
  ['divergence legend mounted', html.includes('pv-divlegend') && html.includes('≥30')],
]
let failed = 0
for (const [name, ok] of checks) { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }

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
process.exit(failed ? 1 : 0)
