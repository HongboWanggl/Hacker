// Client-side: batch table keyboard navigation. Batch rows are plain divs
// (not natively focusable), so Enter/Space toggle the drill-down like a
// click, ↑/↓/Home/End rove focus across expandable rows, and rows expose
// role=button + aria-expanded. Offline via happy-dom.
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
const anyFn = new Proxy(() => {}, {
  get: (_t, k) => (k === Symbol.toPrimitive ? () => 0 : anyFn),
  apply: () => anyFn,
})
win.HTMLCanvasElement.prototype.getContext = () => anyFn

const React = (await import('../../../node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')).default
const { createRoot } = await import(
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
const reg = ctx.slots.registrations.find((r) => r.def.key === 'batch_predict')
const report = {
  summary: { ok: 2, failed: 1, meanPlddt: 78.7 },
  jobs: [
    {
      accession: 'P61626',
      name: 'Lysozyme C',
      status: 'ok',
      residues: 130,
      meanPlddt: 92.4,
      lowSegments: 0,
      savedTo: 'structures/lyz.pdb',
    },
    {
      accession: 'P04637',
      name: 'p53',
      status: 'ok',
      residues: 393,
      meanPlddt: 64.9,
      lowSegments: 3,
      savedTo: 'structures/p53.pdb',
    },
    { accession: 'P00439', name: 'PAH', status: 'error', error: 'ESMFold HTTP 413' },
  ],
}
const container = win.document.createElement('div')
win.document.body.appendChild(container)
createRoot(container).render(
  React.createElement(reg.comp, {
    owner: { callId: 'b-k', toolName: 'batch_predict', block: { resultPreview: JSON.stringify(report) } },
    services,
  }),
)
await new Promise((r) => setTimeout(r, 500))

const rows = () => [...container.querySelectorAll('.pv-batch-row--ok')]
const focusedIdx = () => rows().indexOf(win.document.activeElement)
const openRow = () => rows().findIndex((r) => r.className.includes('pv-batch-row--open'))
const key = (el, k) =>
  el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

check(rows().length === 2, `batch table mounted with 2 expandable rows (got ${rows().length})`)
check(
  rows().every((r) => r.getAttribute('tabindex') === '0' && r.getAttribute('role') === 'button'),
  'rows are focusable buttons (tabindex=0, role=button)',
)
check(
  rows().every((r) => r.getAttribute('aria-expanded') === 'false'),
  'rows start collapsed (aria-expanded=false)',
)

rows()[0].focus()
check(focusedIdx() === 0, 'first row focusable')
key(win.document.activeElement, 'Enter')
await new Promise((r) => setTimeout(r, 100))
check(openRow() === 0, 'Enter expands the focused row')
check(rows()[0].getAttribute('aria-expanded') === 'true', 'expanded row exposes aria-expanded=true')
key(win.document.activeElement, 'Enter')
await new Promise((r) => setTimeout(r, 100))
check(openRow() === -1, 'Enter again collapses the row')

key(win.document.activeElement, ' ')
await new Promise((r) => setTimeout(r, 100))
check(openRow() === 0, 'Space also toggles the drill-down')
key(win.document.activeElement, ' ')
await new Promise((r) => setTimeout(r, 100))
check(openRow() === -1, 'Space again collapses')

key(win.document.activeElement, 'ArrowDown')
check(focusedIdx() === 1, 'ArrowDown moves row focus to #2')
key(win.document.activeElement, 'ArrowDown')
check(focusedIdx() === 1, 'ArrowDown at last expandable row clamps')
key(win.document.activeElement, 'ArrowUp')
check(focusedIdx() === 0, 'ArrowUp moves back to #1')
key(win.document.activeElement, 'End')
check(focusedIdx() === 1, 'End jumps to last expandable row')
key(win.document.activeElement, 'Home')
check(focusedIdx() === 0, 'Home jumps to first row')

console.log(failed ? 'KBD BATCH FAIL' : 'KBD BATCH OK')
process.exit(failed ? 1 : 0)
