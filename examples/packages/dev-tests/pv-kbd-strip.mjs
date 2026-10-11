// Client-side: sequence strip keyboard navigation. The strip is one focusable
// listbox; ←/→ drive a roving cursor through the same hover state the mouse
// uses, Enter selects, Home/End jump, Esc blurs. Offline via happy-dom.
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
const recording = new Proxy(
  {},
  {
    get(_t, k) {
      if (k === 'canvas') return { width: 300, height: 300 }
      return () => anyFn
    },
    set() {
      return true
    },
  },
)
win.HTMLCanvasElement.prototype.getContext = () => recording
const React = (await import('../../../node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')).default
const { createRoot } = await import(
  '../../../node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js'
)
const mod = await import('/tmp/pv-client-test/index.js')
const services = { call: async () => ({ residues: [] }) }
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
const container = win.document.createElement('div')
win.document.body.appendChild(container)
const N = 12
const res = Array.from({ length: N }, (_, i) => ({
  i: i + 1,
  aa: 'ACDEFGHIJKL'[i],
  x: i * 3.8,
  y: 0,
  z: 0,
  b: 90 - i * 4,
  chain: 'A',
}))
const report = {
  savedTo: 'structures/t.pdb',
  path: 'structures/t.pdb',
  residues: N,
  meanPlddt: 70,
  lowSegments: [],
}
services.call = async () => ({ n: N, residues: res, sequence: res.map((r) => r.aa).join('') })
createRoot(container).render(
  React.createElement(reg.comp, {
    owner: { callId: 'l', toolName: 'predict_structure', block: { resultPreview: JSON.stringify(report) } },
    services,
  }),
)
await new Promise((r) => setTimeout(r, 600))

let failed = 0
const check = (ok, msg) => {
  console.log(ok ? 'ok ' : 'FAIL', msg)
  if (!ok) failed++
}
const strip = container.querySelector('.pv-seqstrip')
const tiles = [...container.querySelectorAll('.pv-seq-tile')]
check(strip && tiles.length === N, `strip mounted with ${N} tiles`)

check(strip.getAttribute('tabindex') === '0', 'strip is focusable (tabindex=0)')
check(strip.getAttribute('role') === 'listbox', 'strip role=listbox')
check(
  tiles.every((t) => t.getAttribute('role') === 'option'),
  'tiles have role=option',
)
check(
  tiles.every((t) => t.getAttribute('aria-selected') === 'false'),
  'tiles start unselected (aria-selected=false)',
)

const key = (el, k) =>
  el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
const hoverIdx = () =>
  [...container.querySelectorAll('.pv-seq-tile')].findIndex((t) => t.className.includes('pv-seq-tile--hover'))
const selIdx = () =>
  [...container.querySelectorAll('.pv-seq-tile')].findIndex((t) => t.className.includes('pv-seq-tile--sel'))
// React state flushes are async under happy-dom's scheduler and only pump
// when further React-delegated discrete events arrive (a synthetic `click` on
// the strip container has no handlers but still flushes React's pending work
// at the root listener; keydown does not). In a real browser discrete
// keydowns flush synchronously, so none of this timing matters.
const waitFor = async (fn, ms = 2000) => {
  const t0 = Date.now()
  let v = fn()
  while (!v && Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 25))
    strip.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
    v = fn()
  }
  return v
}

strip.focus()
strip.dispatchEvent(new win.FocusEvent('focusin', { bubbles: true }))
await waitFor(() => hoverIdx() === 0)
check(hoverIdx() === 0, `focus starts cursor at first tile (hover=${hoverIdx()})`)

key(strip, 'ArrowRight')
check((await waitFor(() => hoverIdx() === 1)) === true, 'ArrowRight moves cursor to #2')
key(strip, 'ArrowRight')
check((await waitFor(() => hoverIdx() === 2)) === true, 'ArrowRight moves cursor to #3 (hover=2)')
// The panel root steps `selected` on ←/→; the strip must swallow the keys so
// navigation and panel-level stepping don't fight over the same event.
check(selIdx() === -1, 'strip arrows do not leak into panel-level selection')

key(strip, 'ArrowLeft')
check((await waitFor(() => hoverIdx() === 1)) === true, 'ArrowLeft moves back to #2')

key(strip, 'Enter')
check((await waitFor(() => selIdx() === 1)) === true, 'Enter selects residue #2')
check(
  container.querySelectorAll('.pv-seq-tile')[1].getAttribute('aria-selected') === 'true',
  'selected tile has aria-selected=true',
)

key(strip, 'End')
check((await waitFor(() => hoverIdx() === N - 1)) === true, `End jumps to last tile (hover=${N - 1})`)

key(strip, 'Home')
check((await waitFor(() => hoverIdx() === 0)) === true, 'Home jumps to first tile')

key(strip, 'ArrowLeft')
await waitFor(() => false, 120)
check(hoverIdx() === 0, 'ArrowLeft at start clamps to first tile')

strip.dispatchEvent(new win.FocusEvent('focusout', { bubbles: true }))
strip.blur()
check((await waitFor(() => hoverIdx() === -1)) === true, 'blur clears the cursor highlight')

console.log(failed ? 'KBD STRIP FAIL' : 'KBD STRIP OK')
process.exit(failed ? 1 : 0)
