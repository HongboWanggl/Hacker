// Client-side: mount the confidence panel with residues across all pLDDT bands
// and assert each strip tile's text color follows the luminance rule.
import { Window } from '/Users/wanghanbao/agnes-harness/node_modules/.pnpm/happy-dom@20.14.3/node_modules/happy-dom/lib/index.js'
const win = new Window()
globalThis.window = win
globalThis.document = win.document
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(16), 16)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.devicePixelRatio = 1
const anyFn = new Proxy(function () {}, { get: () => anyFn, apply: () => anyFn })
const recording = new Proxy({}, {
  get(t, k) { if (k === 'canvas') return { width: 300, height: 300 }; return () => anyFn },
  set() { return true },
})
win.HTMLCanvasElement.prototype.getContext = function () { return recording }
const React = (await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')).default
const { createRoot } = await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js')
const mod = await import('/tmp/pv-client-test/index.js')
const services = { call: async () => ({ residues: [], }) }
const ctx = { slots: { registrations: [], register(def, comp) { this.registrations.push({ def, comp }) }, spec: () => ({ kind: 'keyed' }), entriesOfSlot() { return this.registrations.map((r) => ({ options: r.def })) }, subscribeDeclaration: () => () => {} }, agnes: { services }, effect: (f) => { const off = f(); return typeof off === 'function' ? off : undefined } }
mod.apply(ctx)
const reg = ctx.slots.registrations.find((r) => r.def.key === 'predict_structure')
const container = win.document.createElement('div')
win.document.body.appendChild(container)
const res = [95, 80, 60, 40].map((b, i) => ({ i: i + 1, aa: 'ACDE'[i], x: i * 3.8, y: 0, z: 0, b, chain: 'A' }))
const report = { savedTo: 'structures/t.pdb', path: 'structures/t.pdb', residues: 4, meanPlddt: 68.8, lowSegments: [] }
services.call = async () => ({ n: 4, residues: res, sequence: 'ACDE' })
createRoot(container).render(React.createElement(reg.comp, { owner: { callId: 'l', toolName: 'predict_structure', block: { resultPreview: JSON.stringify(report) } }, services }))
await new Promise((r) => setTimeout(r, 600))
const tiles = [...container.querySelectorAll('.pv-seq-tile')]
console.log('tiles:', tiles.length)
let failed = 0
for (const t of tiles) {
  const bg = t.style.background
  const color = t.style.color
  console.log('bg', bg, '→ color', color)
}
const want = ['rgb(255 255 255 / 88%)', 'rgb(20 20 20 / 85%)', 'rgb(20 20 20 / 85%)', 'rgb(20 20 20 / 85%)']
const bgs = ['#0053d6', '#65cbf3', '#ffdb13', '#ff7d45']
tiles.forEach((t, i) => {
  const okC = t.style.color === want[i]
  console.log(okC ? 'ok ' : 'FAIL', `tile ${i + 1} bg ${bgs[i]} → ${t.style.color}`)
  if (!okC) failed++
})
if (tiles.length !== 4) failed++
// Canvas accessibility: role=img + aria-label on the shared 3D / curve canvases
const canv = [
  ['.pv-3d', '蛋白质 3D 结构视图'],
  ['.pv-curve', '逐残基 pLDDT 置信度曲线'],
]
for (const [sel, labelPrefix] of canv) {
  const el = container.querySelector(sel)
  const okA = el && el.getAttribute('role') === 'img' && (el.getAttribute('aria-label') ?? '').includes(labelPrefix)
  console.log(okA ? 'ok ' : 'FAIL', `${sel} role=img + aria-label`)
  if (!okA) failed++
}
console.log(failed ? 'TILE TEXT FAIL' : 'TILE TEXT OK')
process.exit(failed ? 1 : 0)
