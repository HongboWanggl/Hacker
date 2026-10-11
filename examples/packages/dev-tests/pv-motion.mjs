// Client-side: auto-rotate respects the OS "prefers-reduced-motion: reduce"
// setting — the toolbar checkbox defaults to OFF when reduced motion is
// requested (and can be re-enabled by hand), ON otherwise. happy-dom mounts
// the predict_structure panel twice with different matchMedia stubs.
import { Window } from '../../../node_modules/.pnpm/happy-dom@20.14.3/node_modules/happy-dom/lib/index.js'

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
const anyFn = new Proxy(() => {}, { get: () => anyFn, apply: () => anyFn })
win.HTMLCanvasElement.prototype.getContext = () => anyFn
const React = (await import('../../../node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')).default
const { createRoot: cr } = await import(
  '../../../node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js'
)
const mod = await import('/tmp/pv-client-test/index.js')

let failed = 0
const check = (cond, name) => {
  console.log(cond ? 'ok ' : 'FAIL', name)
  if (!cond) failed++
}

const services = {
  call: async () => ({
    n: 4,
    sequence: 'AAAA',
    residues: [
      { i: 1, chain: 'A', aa: 'A', x: 0, y: 0, z: 0, b: 80 },
      { i: 2, chain: 'A', aa: 'A', x: 4, y: 0, z: 0, b: 82 },
    ],
  }),
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
const reg = ctx.slots.registrations.find((r) => r.def.key === 'predict_structure')
const report = {
  savedTo: 'structures/t.pdb',
  path: 'structures/t.pdb',
  residues: 2,
  meanPlddt: 80,
  lowSegments: [],
}

// matchMedia stubs: reduced-motion ON, then OFF.
win.matchMedia = (q) => ({ matches: q.includes('prefers-reduced-motion'), media: q })

const c1 = win.document.createElement('div')
win.document.body.appendChild(c1)
cr(c1).render(
  React.createElement(reg.comp, {
    owner: { callId: 'm1', toolName: 'predict_structure', block: { resultPreview: JSON.stringify(report) } },
    services,
  }),
)
await new Promise((r) => setTimeout(r, 600))

const spinBox = (root) => {
  const lbl = [...root.querySelectorAll('.pv-toggle')].find((l) => (l.textContent ?? '').includes('自动旋转'))
  return lbl?.querySelector('input[type=checkbox]')
}

const box1 = spinBox(c1)
check(!!box1, 'toolbar renders 自动旋转 checkbox')
check(box1 && !box1.checked, 'reduced-motion OS setting defaults auto-spin OFF')

win.matchMedia = (q) => ({ matches: false, media: q })
const c2 = win.document.createElement('div')
win.document.body.appendChild(c2)
cr(c2).render(
  React.createElement(reg.comp, {
    owner: { callId: 'm2', toolName: 'predict_structure', block: { resultPreview: JSON.stringify(report) } },
    services,
  }),
)
await new Promise((r) => setTimeout(r, 600))
const box2 = spinBox(c2)
check(box2?.checked, 'without reduced motion auto-spin stays ON (existing behavior)')

box2.click()
await new Promise((r) => setTimeout(r, 100))
check(box2 && !box2.checked, 'manual toggle still turns auto-spin off')
box2.click()
await new Promise((r) => setTimeout(r, 100))
check(box2?.checked, 'manual toggle re-enables auto-spin under reduced motion too')

// No matchMedia at all (older webviews) must not crash and must default ON.
delete win.matchMedia
const c3 = win.document.createElement('div')
win.document.body.appendChild(c3)
cr(c3).render(
  React.createElement(reg.comp, {
    owner: { callId: 'm3', toolName: 'predict_structure', block: { resultPreview: JSON.stringify(report) } },
    services,
  }),
)
await new Promise((r) => setTimeout(r, 600))
const box3 = spinBox(c3)
check(box3?.checked, 'missing matchMedia falls back to auto-spin ON')

console.log(failed ? 'MOTION FAIL' : 'MOTION OK')
process.exit(failed ? 1 : 0)
