// Client-side: the compare panel's divergence strip re-uses SequenceStrip, so
// it inherits the full keyboard listbox (focus cursor, ←/→/Home/End, Enter
// picks the residue). This pins that inheritance so a future bespoke compare
// strip can't silently drop keyboard access. Offline via happy-dom.
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
win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,'
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
const waitFor = async (cond, tries = 25) => {
  for (let i = 0; i < tries; i++) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 40))
  }
  return cond()
}

const mk = (n) =>
  Array.from({ length: n }, (_, i) => ({
    i: i + 1,
    aa: 'A',
    x: i * 3.8 - 40,
    y: Math.sin(i) * 5,
    z: Math.cos(i) * 5,
    b: 60 + i,
  }))
const services = {
  call: async (name, input) => {
    if (name !== 'protein.structure') throw new Error(`unexpected ${name}`)
    const res = mk(20).map((r) => (input.path.includes('alphafold_ref') ? { ...r, b: r.b - 5 } : r))
    return { n: 20, sequence: 'A'.repeat(20), residues: res }
  },
}
const report = {
  accession: 'P04637',
  model: 'AF-P04637-F1 (v6)',
  alphafold: { residues: 393, meanPlddt: 75.1, savedTo: 'structures/P04637_alphafold_ref.pdb' },
  prediction: { path: 'structures/p53.pdb', residues: 393, meanPlddt: 80.3 },
  compared: {
    overlappingResidues: 393,
    meanAbsPlddtDelta: 11.1,
    caRmsd: 21.009,
    largestDeltas: [{ residue: 3, delta: 45.2 }],
    deltaSeries: [
      { residue: 1, delta: 40.1 },
      { residue: 40, delta: 12.2 },
    ],
    superposition: { q: [0.9659, 0.0692, 0.1383, 0.2075], pc: [1.1, 2.2, 3.3], qc: [0.4, 0.5, 0.6] },
    verdict: 'significant deviation (CA-RMSD > 4 Å)',
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
const comp = ctx.slots.registrations.find((r) => r.def.key === 'compare_alphafold').comp
const container = win.document.createElement('div')
win.document.body.appendChild(container)
createRoot(container).render(
  React.createElement(comp, {
    owner: { callId: 'c-k', toolName: 'compare_alphafold', block: { resultPreview: JSON.stringify(report) } },
    services,
  }),
)
await new Promise((r) => setTimeout(r, 700))

const strip = container.querySelector('.pv-seqstrip')
const tiles = () => [...container.querySelectorAll('.pv-seq-tile')]
const hoverIdx = () => tiles().findIndex((t) => t.className.includes('pv-seq-tile--hover'))
const key = (el, k) =>
  el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

check(!!strip, 'compare panel mounts the divergence strip')
check(strip?.getAttribute('role') === 'listbox', 'strip is a focusable listbox (role=listbox)')
check(tiles().length === 20, `strip renders 20 tiles (got ${tiles().length})`)

strip?.focus()
check((await waitFor(() => hoverIdx() === 0)) === true, 'focus starts cursor at first tile')
key(win.document.activeElement, 'ArrowRight')
check((await waitFor(() => hoverIdx() === 1)) === true, 'ArrowRight moves cursor to #2')
key(win.document.activeElement, 'End')
check((await waitFor(() => hoverIdx() === 19)) === true, 'End jumps to last tile')
key(win.document.activeElement, 'Home')
check((await waitFor(() => hoverIdx() === 0)) === true, 'Home jumps back to first tile')

// Enter picks the residue (onPickRes → 镜头定位); panel must not crash and the
// picked tile becomes aria-selected.
key(win.document.activeElement, 'Enter')
await new Promise((r) => setTimeout(r, 200))
check(tiles()[0]?.getAttribute('aria-selected') === 'true', 'Enter selects the residue (aria-selected=true)')
check(container.innerHTML.length > 1000, 'panel still renders after keyboard pick')

console.log(failed ? 'KBD COMPARE FAIL' : 'KBD COMPARE OK')
process.exit(failed ? 1 : 0)
