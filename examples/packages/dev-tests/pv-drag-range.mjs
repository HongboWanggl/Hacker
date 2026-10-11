// Client-side: dragging across sequence-strip tiles commits a segment focus
// (the same highlightSeg machinery the jump box's "36-42" and the
// low-confidence chips drive). Same-tile press stays a plain click-select;
// a cross-chain drag on complexes is refused. Offline via happy-dom.
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
const { createRoot } = await import(
  '../../../node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js'
)
const mod = await import('/tmp/pv-client-test/index.js')

let failed = 0
const check = (cond, name) => {
  console.log(cond ? 'ok ' : 'FAIL', name)
  if (!cond) failed++
}

const mkCtx = () => ({
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
  agnes: {},
  effect: (f) => {
    const off = f()
    return typeof off === 'function' ? off : undefined
  },
})

const mkResidues = (n, chain) =>
  Array.from({ length: n }, (_, i) => ({
    i: i + 1,
    chain,
    aa: 'A',
    x: i * 3.8 - 80,
    y: Math.sin(i) * 5,
    z: Math.cos(i) * 5,
    b: 60 + i,
  }))
const servicesFor = (residues) => ({
  call: async () => ({ n: residues.length, sequence: 'A'.repeat(residues.length), residues }),
})
const report = (n, name) => ({
  residues: n,
  meanPlddt: 65,
  bands: {},
  lowConfidenceSegments: [],
  savedTo: `structures/${name}.pdb`,
})

const mouse = (el, type) =>
  // React derives onMouseEnter from bubbling mouseover, so map enter→mouseover.
  el.dispatchEvent(
    new win.MouseEvent(type === 'mouseenter' ? 'mouseover' : type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
    }),
  )

async function mount(residues, name) {
  const ctx = mkCtx()
  const services = servicesFor(residues)
  ctx.agnes = { services }
  mod.apply(ctx)
  const reg = ctx.slots.registrations.find((r) => r.def.key === 'predict_structure')
  const container = win.document.createElement('div')
  win.document.body.appendChild(container)
  createRoot(container).render(
    React.createElement(reg.comp, {
      owner: {
        callId: `d-${name}`,
        toolName: 'predict_structure',
        block: { resultPreview: JSON.stringify(report(residues.length, name)) },
      },
      services,
    }),
  )
  await new Promise((r) => setTimeout(r, 500))
  return container
}

const fmt = (c) => c.querySelector('.pv-fmt')?.textContent ?? ''
const tiles = (c) => [...c.querySelectorAll('.pv-seq-tile')]

// --- single chain: drag tiles 5 → 12 focuses residues 6–13
{
  const c = await mount(mkResidues(40, undefined), 'drag1')
  const ts = tiles(c)
  mouse(ts[5], 'mousedown')
  mouse(ts[8], 'mouseenter')
  await new Promise((r) => setTimeout(r, 100))
  check(
    ts.slice(5, 9).every((t) => t.className.includes('pv-seq-tile--range')),
    'mid-drag range tiles carry the --range class',
  )
  mouse(ts[12], 'mouseenter')
  mouse(ts[12], 'mouseup')
  await new Promise((r) => setTimeout(r, 200))
  check(fmt(c).includes('聚焦区段 6–13'), `drag 5→12 commits 聚焦区段 6–13 (got "${fmt(c)}")`)
  check(!tiles(c)[8].className.includes('pv-seq-tile--range'), 'drag visuals clear after commit')
  // same-tile press = plain click-select — it must not disturb the focus set
  // by the previous drag (a no-op press is not a toggle).
  mouse(tiles(c)[20], 'mousedown')
  mouse(tiles(c)[20], 'mouseup')
  await new Promise((r) => setTimeout(r, 100))
  check(fmt(c).includes('聚焦区段 6–13'), 'same-tile press keeps the previous segment focus')
  // reverse drag normalizes to lo-hi
  mouse(tiles(c)[15], 'mousedown')
  mouse(tiles(c)[10], 'mouseenter')
  mouse(tiles(c)[10], 'mouseup')
  await new Promise((r) => setTimeout(r, 100))
  check(fmt(c).includes('聚焦区段 11–16'), `reverse drag normalizes (got "${fmt(c)}")`)
  c.remove()
}

// --- multi-chain: in-chain drag ok (chain-prefixed), cross-chain refused
{
  const c = await mount([...mkResidues(10, 'A'), ...mkResidues(10, 'B')], 'drag2')
  const ts = tiles(c)
  mouse(ts[2], 'mousedown')
  mouse(ts[5], 'mouseenter')
  mouse(ts[5], 'mouseup')
  await new Promise((r) => setTimeout(r, 100))
  check(fmt(c).includes('聚焦区段 A:3–6'), `in-chain drag commits A:3–6 (got "${fmt(c)}")`)
  mouse(ts[3], 'mousedown')
  mouse(ts[12], 'mouseenter')
  mouse(ts[12], 'mouseup')
  await new Promise((r) => setTimeout(r, 100))
  check(fmt(c).includes('聚焦区段 A:3–6'), 'cross-chain drag is refused and keeps the previous focus')
  c.remove()
}

console.log(failed ? 'DRAG RANGE FAIL' : 'DRAG RANGE OK')
process.exit(failed ? 1 : 0)
