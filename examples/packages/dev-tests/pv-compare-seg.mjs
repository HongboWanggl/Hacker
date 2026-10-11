// Client-side: the compare card's divergence strip supports drag-select
// segment focus — dragging a range fades the prediction's out-of-segment
// residues in the 3D overlay (shared Structure3D seg machinery), with a
// clickable 聚焦区段 chip to clear. Offline via happy-dom + recording ctx.
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

const DIM = 'rgba(120,130,150,0.25)'

function recordingCtx() {
  const t = { canvas: null, __strokes: [] }
  return new Proxy(t, {
    get(target, prop) {
      if (prop === 'stroke') return () => void target.__strokes.push(target.strokeStyle)
      if (prop === 'fill') return () => void target.__strokes.push(null)
      if (prop === 'measureText') return () => ({ width: 10 })
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient')
        return () => ({ addColorStop() {} })
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) })
      if (prop in target) return target[prop]
      return () => {}
    },
    set(target, prop, v) {
      target[prop] = v
      return true
    },
  })
}

// Zig-zag keeps consecutive Cα ~3.8 Å so the 4.5 Å bond gate produces bonds.
const mk = (n, bShift = 0) =>
  Array.from({ length: n }, (_, i) => ({
    i: i + 1,
    aa: 'A',
    x: i * 3.8,
    y: (i % 2) * 0.5,
    z: 0,
    b: 55 + i + bShift,
  }))
const services = {
  call: async (name, input) => {
    if (name !== 'protein.structure') throw new Error(`unexpected ${name}`)
    const res = mk(30, input.path.includes('alphafold_ref') ? -5 : 0)
    return { n: 30, sequence: 'A'.repeat(30), residues: res }
  },
}
const report = {
  accession: 'P04637',
  model: 'AF-P04637-F1 (v6)',
  alphafold: { residues: 30, meanPlddt: 75.1, savedTo: 'structures/P04637_alphafold_ref.pdb' },
  prediction: { path: 'structures/p53.pdb', residues: 30, meanPlddt: 80.3 },
  compared: {
    overlappingResidues: 30,
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
    owner: {
      callId: 'c-seg',
      toolName: 'compare_alphafold',
      block: { resultPreview: JSON.stringify(report) },
    },
    services,
  }),
)
await new Promise((r) => setTimeout(r, 700))

const tiles = () => [...container.querySelectorAll('.pv-seq-tile')]
check(tiles().length === 30, `compare strip mounted with tiles (got ${tiles().length})`)

// Attach a recording context to the compare 3D canvas.
const cv = container.querySelector('canvas.pv-3d')
check(!!cv, 'compare panel mounts its 3D canvas')
const rc = recordingCtx()
cv.getContext = () => rc
const dimCount = () => rc.__strokes.filter((s) => s === DIM).length
const resetStrokes = () => {
  rc.__strokes.length = 0
}

const mouse = (el, type) =>
  el.dispatchEvent(
    new win.MouseEvent(type === 'mouseenter' ? 'mouseover' : type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1,
    }),
  )
const ts = tiles()
mouse(ts[5], 'mousedown')
mouse(ts[8], 'mouseenter')
mouse(ts[12], 'mouseenter')
mouse(ts[12], 'mouseup')
await new Promise((r) => setTimeout(r, 400))
const chip = () => container.querySelector('button.pv-fmt--clear')
check(
  (chip()?.textContent ?? '').includes('聚焦区段 6–13'),
  `drag commits 聚焦区段 6–13 (got "${chip()?.textContent}")`,
)
check(dimCount() > 0, `out-of-segment prediction bonds fade (got ${dimCount()} dim strokes)`)
check(
  rc.__strokes.some((s) => s && s !== DIM),
  'in-segment bonds keep their colors',
)

// Clicking the chip clears the focus.
resetStrokes()
chip().dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
await new Promise((r) => setTimeout(r, 400))
check(!container.querySelector('.pv-fmt--clear'), 'chip click clears the focus (label gone)')
check(dimCount() === 0, `dim bonds gone after clearing (got ${dimCount()})`)

console.log(failed ? 'COMPARE SEG FAIL' : 'COMPARE SEG OK')
process.exit(failed ? 1 : 0)
