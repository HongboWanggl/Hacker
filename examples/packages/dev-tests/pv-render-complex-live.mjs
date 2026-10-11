// Client-side render (effects run) for the predict_complex panel path.
import { Window } from '/Users/wanghanbao/agnes-harness/node_modules/.pnpm/happy-dom@20.14.3/node_modules/happy-dom/lib/index.js'

const win = new Window()
globalThis.window = win
globalThis.document = win.document
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true })
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(16), 16)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.devicePixelRatio = 1
// canvas 2d context stub for Structure3D
const anyFn = new Proxy(() => {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : anyFn),
  apply: () => anyFn,
})
win.HTMLCanvasElement.prototype.getContext = () => anyFn

const React = (
  await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')
).default
const { createRoot } = await import(
  '/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js'
)

const mod = await import('/tmp/pv-client-test/index.js')
const services = {
  call: async (name, _input) => {
    if (name !== 'protein.structure') throw new Error(`unexpected ${name}`)
    // Two chains, both numbered 1-10 (Boltz-2 complex shape) — exercises chain
    // color mode, the chain legend, and chain-prefix readouts.
    const residues = []
    for (let i = 1; i <= 10; i++)
      residues.push({
        i,
        chain: 'A',
        aa: 'A',
        x: i * 3.8 - 40,
        y: Math.sin(i) * 5,
        z: Math.cos(i) * 5,
        b: 60 + i,
      })
    for (let i = 1; i <= 10; i++)
      residues.push({
        i,
        chain: 'B',
        aa: 'G',
        x: i * 3.8 - 20,
        y: Math.cos(i) * 5,
        z: Math.sin(i) * 5,
        b: 80 - i,
      })
    return { n: 20, sequence: 'A'.repeat(10) + 'G'.repeat(10), residues }
  },
}
const ctx = {
  slots: {
    registrations: [],
    register(def, comp) {
      this.registrations.push({ def, comp })
    },
    spec: () => ({ kind: 'keyed' }),
    entriesOfSlot() {
      return this.registrations.map((r) => ({ options: r.def }))
    },
    subscribeDeclaration: () => () => {},
  },
  agnes: { services },
  effect: (f) => {
    const off = f()
    return typeof off === 'function' ? off : undefined
  },
}
mod.apply(ctx)
const complexReg = ctx.slots.registrations.find((r) => r.def.key === 'predict_complex')
const report = {
  predictionId: 'pred_123',
  savedTo: 'structures/complex_boltz.pdb',
  chains: 2,
  hasLigand: true,
  residues: 20,
  ptm: 88.1,
  iptm: 82.5,
  bindingConfidence: 87.3,
  verdict: 'predicted to bind with high confidence',
}
const container = win.document.createElement('div')
win.document.body.appendChild(container)
createRoot(container).render(
  React.createElement(complexReg.comp, {
    owner: { callId: 'c', toolName: 'predict_complex', block: { resultPreview: JSON.stringify(report) } },
    services,
  }),
)
await new Promise((r) => setTimeout(r, 400))
const html = container.innerHTML
const checks = [
  ['complex score card', html.includes('87.3') && html.includes('结合置信度')],
  ['3D column mounted', html.includes('pv-3d-col')],
  ['3D canvas mounted', html.includes('pv-3d')],
  ['curve mounted', html.includes('pv-curve')],
  ['chain legend rendered', (html.match(/pv-chain-chip/g) ?? []).length === 2],
  ['legend shows both chains with counts', html.includes('链 A · 10 aa') && html.includes('链 B · 10 aa')],
  ['legend shows per-chain mean pLDDT', html.includes('均值 pLDDT 65.5') && html.includes('均值 pLDDT 74.5')],
]
let failed = 0
for (const [name, ok] of checks) {
  console.log(ok ? 'ok ' : 'FAIL', name)
  if (!ok) failed++
}

// chain visibility toggle: chips are buttons; clicking one marks it off, the
// last visible chain refuses to hide, re-clicking restores.
const chips = [...container.querySelectorAll('button.pv-chain-chip')]
checks.push(['legend chips are toggle buttons', chips.length === 2])
if (chips.length === 2) {
  chips[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 200))
  checks.push([
    'click hides chain A chip',
    chips[0].className.includes('pv-chain-chip--off') && !chips[1].className.includes('pv-chain-chip--off'),
  ])
  chips[1].dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 200))
  checks.push(['last visible chain refuses to hide', !chips[1].className.includes('pv-chain-chip--off')])
  chips[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 200))
  checks.push(['re-click restores chain A', !chips[0].className.includes('pv-chain-chip--off')])
}
for (const [name, ok] of checks.slice(chips.length === 2 ? -4 : -1)) {
  console.log(ok ? 'ok ' : 'FAIL', name)
  if (!ok) failed++
}
process.exit(failed ? 1 : 0)
