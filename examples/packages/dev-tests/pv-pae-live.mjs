// Client-side render (effects run) for the PaesModule path: fake protein.pae
// service feeds a 4×4 matrix; checks canvas mount, hover readout, and export
// buttons. Run via run-all.sh (cwd = dev-tests).
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
// 4×4 matrix, row-major bytes: diag ~0 (confident), off-diag larger.
const mat = Uint8Array.from([0, 90, 160, 255, 90, 0, 120, 200, 160, 120, 0, 60, 255, 200, 60, 0])
const services = {
  call: async (name, input) => {
    if (name === 'protein.structure') {
      const residues = []
      for (const chain of ['A', 'B']) {
        for (let i = 1; i <= 2; i++) residues.push({ i, chain, aa: 'A', x: i, y: 1, z: 2, b: 80 })
      }
      return { n: 4, sequence: 'AAAA', residues }
    }
    if (name === 'protein.pae') {
      if (input.path !== 'structures/x_pae.npz') throw new Error('unexpected pae path ' + input.path)
      return { n: 4, data: Buffer.from(mat).toString('base64') }
    }
    throw new Error('unexpected ' + name)
  },
}
const ctx = { slots: { registrations: [], register(def, comp) { this.registrations.push({ def, comp }) }, spec: () => ({ kind: 'keyed' }), entriesOfSlot() { return this.registrations.map((r) => ({ options: r.def })) }, subscribeDeclaration: () => () => {} }, agnes: { services }, effect: (f) => { const off = f(); return typeof off === 'function' ? off : undefined } }
mod.apply(ctx)
const complexReg = ctx.slots.registrations.find((r) => r.def.key === 'predict_complex')
const report = {
  predictionId: 'pred_123', savedTo: 'structures/complex_boltz.pdb', chains: 2, hasLigand: true, residues: 4,
  ptm: 88.1, iptm: 82.5, bindingConfidence: 87.3, verdict: 'predicted to bind with high confidence',
  paePath: 'structures/x_pae.npz',
}
const container = win.document.createElement('div')
win.document.body.appendChild(container)
createRoot(container).render(React.createElement(complexReg.comp, { owner: { callId: 'c-pae', toolName: 'predict_complex', block: { resultPreview: JSON.stringify(report) } }, services }))
await new Promise((r) => setTimeout(r, 500))

let failed = 0
const check = (name, ok) => { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }
const html = container.innerHTML
check('PAE module mounts with canvas', !!container.querySelector('canvas.pv-pae-canvas'))
// n=4 upscales at cell=8 → 32×32 display canvas (nearest-neighbour, by design)
check('canvas upscaled to 32×32', container.querySelector('canvas.pv-pae-canvas')?.width === 32)
check('legend bar present', !!container.querySelector('.pv-pae-legendbar'))
check('export PNG button', [...container.querySelectorAll('.pv-pae button.pv-export')].some((b) => b.textContent === '导出 PNG'))
check('export CSV button', [...container.querySelectorAll('.pv-pae button.pv-export')].some((b) => b.textContent === '导出 CSV'))
check('caption present', container.querySelector('.pv-pae-caption')?.textContent.includes('链边界') ?? false)

// hover readout: stub rect (0,0,100,100), n=4 → 25 px cells. clientX 37.5 →
// i=1, clientY 62.5 → j=2 (62.5/25 = 2.5) → byte 120 → "A:A2 → B:A1 · 15.06 Å".
const canvas = container.querySelector('canvas.pv-pae-canvas')
canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 })
canvas.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 37.5, clientY: 62.5 }))
await new Promise((r) => setTimeout(r, 200))
const readout = container.querySelector('.pv-pae-side .pv-hoverline')?.textContent ?? ''
check(`hover readout cell(1,2) (got "${readout}")`, readout === 'A:A2 → B:A1 · 15.06 Å')

process.exit(failed ? 1 : 0)
console.log('PAE PANEL TESTS DONE')
