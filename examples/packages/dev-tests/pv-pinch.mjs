// Client-side: pinch-to-zoom on the 3D canvas — two pointers spread → the
// projection scale grows (zoom ×~2), the release must not register as a
// residue click, a ghost release (lost pointer) must not wedge the gesture
// state, and single-finger rotate / click-to-select keep working.
// Offline constraints that shape this probe:
//  - React derives onPointerLeave from pointerout, so synthetic 'pointerleave'
//    never fires here — hover is cleared by moving to an empty corner instead.
//  - prefersReducedMotion() disables auto-spin offline and the adaptive loop
//    sleeps when static, so every measured frame is driven by a hover state
//    change (hover → effect re-run → canvas draw).
//  - Residues here have no chain field, so the selection tag reads `A11`
//    (aa letter + index), not `A:A11`.
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

// Recording 2D context: logs every path coordinate pair so the projected
// extent (and therefore the zoom scale) is observable, plus fillText tags.
function recordingCtx() {
  const t = { canvas: null, __strokes: [], __texts: [], __pts: [] }
  return new Proxy(t, {
    get(target, prop) {
      if (prop === 'stroke') return () => void target.__strokes.push(target.strokeStyle)
      if (prop === 'fill') return () => void target.__strokes.push(null)
      if (prop === 'fillText') return (txt) => void target.__texts.push(txt)
      if (prop === 'moveTo' || prop === 'lineTo') return (x, y) => void target.__pts.push([x, y])
      if (prop === 'measureText') return () => ({ width: 10 })
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient')
        return () => ({ addColorStop() {} })
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) })
      if (prop in target) return target[prop]
      return () => {} // any other ctx method: noop
    },
    set(target, prop, v) {
      target[prop] = v
      return true
    },
  })
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

// Zig-zag keeps consecutive Cα at ~3.8 Å so bonds form.
const mkResidues = (n) =>
  Array.from({ length: n }, (_, i) => ({
    i: i + 1,
    aa: 'A',
    x: i * 3.8,
    y: (i % 2) * 0.5,
    z: 0,
    b: 55 + i,
  }))

const services = {
  call: async () => {
    const residues = mkResidues(20)
    return { n: residues.length, sequence: 'A'.repeat(residues.length), residues }
  },
}
const report = (n, name) => ({
  residues: n,
  meanPlddt: 65,
  bands: {},
  lowConfidenceSegments: [],
  savedTo: `structures/${name}.pdb`,
})

const ctx = mkCtx()
ctx.agnes = { services }
mod.apply(ctx)
const reg = ctx.slots.registrations.find((r) => r.def.key === 'predict_structure')
const container = win.document.createElement('div')
win.document.body.appendChild(container)
createRoot(container).render(
  React.createElement(reg.comp, {
    owner: {
      callId: 'd-pinch',
      toolName: 'predict_structure',
      block: { resultPreview: JSON.stringify(report(20, 'pinch')) },
    },
    services,
  }),
)
await new Promise((r) => setTimeout(r, 500))

const cv = container.querySelector('canvas.pv-3d')
check(!!cv, '3D canvas mounted')
if (!cv) process.exit(1)
cv.setPointerCapture = () => {}
cv.releasePointerCapture = () => {}
cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300 })

// Screen point of residues[10] under the default view (yaw -0.6, pitch 0.35,
// zoom 1) — same projection math the pick() function uses.
const residues = mkResidues(20)
let P = { x: 0, y: 0 }
{
  const c = residues.reduce((a, r) => [a[0] + r.x / 20, a[1] + r.y / 20, a[2] + r.z / 20], [0, 0, 0])
  const maxR = Math.max(...residues.map((r) => Math.hypot(r.x - c[0], r.y - c[1], r.z - c[2])))
  const scale = (300 * 0.42 * 1) / maxR
  const l = [residues[10].x - c[0], residues[10].y - c[1], residues[10].z - c[2]]
  const x1 = l[0] * Math.cos(-0.6) + l[2] * Math.sin(-0.6)
  const z1 = -l[0] * Math.sin(-0.6) + l[2] * Math.cos(-0.6)
  const y1 = l[1] * Math.cos(0.35) - z1 * Math.sin(0.35)
  P = { x: 150 + x1 * scale, y: 150 + y1 * scale }
}

// Synthetic pointer events: each pointer keeps a consistent id across its
// down/move/up stream (the handler tracks pointers by id).
const pointer = (pid, type, x, y) => {
  const ev = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y })
  Object.defineProperty(ev, 'pointerId', { value: pid })
  return ev
}
const pts = () => cv.getContext().__pts
const texts = () => cv.getContext().__texts
const reset = () => {
  const rc = cv.getContext()
  rc.__pts.length = 0
  rc.__strokes.length = 0
  rc.__texts.length = 0
}
const extent = (arr) => (arr.length ? Math.max(...arr.map(([x]) => Math.abs(x - 150))) : -1)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const tip = () => container.querySelector('.pv-3d-tip')?.textContent ?? ''

// The draw effect captures canvas.getContext('2d') when it runs, so replacing
// getContext now is enough — the first hover below re-runs the effect and
// captures the recording ctx from then on.
const rc = recordingCtx()
cv.getContext = () => rc

// Hover drives every redraw: hover a residue, then unhover (empty corner —
// NOT pointerleave, which React never sees from a synthetic dispatch).
const hoverOn = async () => {
  cv.dispatchEvent(pointer(1, 'pointermove', P.x, P.y))
  await wait(300)
}
const hoverOff = async () => {
  cv.dispatchEvent(pointer(1, 'pointermove', 5, 5))
  await wait(300)
}
// Guaranteed null→k hover transition (draws one fresh frame) regardless of
// the current hover state.
const rehover = async () => {
  await hoverOff()
  await hoverOn()
}

// Phase 1 — plumbing: pick finds residue 11, the hover frame draws.
await hoverOn()
check(tip().includes('pLDDT'), `hover readout appears (got "${tip()}")`)
reset()
await rehover()
const base = extent(pts())
check(base > 10, `baseline draws with measurable extent (got ${base.toFixed(1)})`)
await hoverOff()

// Phase 2 — pinch: fingers land 40px apart, spread to 80px → zoom ×2.
// No state changes happen during the pinch itself; the zoomed scale is read
// from the next hover-driven redraw after the release.
reset()
cv.dispatchEvent(pointer(1, 'pointerdown', 130, 100))
cv.dispatchEvent(pointer(2, 'pointerdown', 170, 100))
cv.dispatchEvent(pointer(2, 'pointermove', 190, 100))
cv.dispatchEvent(pointer(2, 'pointermove', 210, 100))
cv.dispatchEvent(pointer(2, 'pointerup', 210, 100))
cv.dispatchEvent(pointer(1, 'pointerup', 130, 100))
reset()
await rehover()
const zoomed = extent(pts())
check(
  zoomed > base * 1.4,
  `pinch spread grows the projection ~×2 (got ${zoomed.toFixed(1)} vs base ${base.toFixed(1)})`,
)
// The pinch release must not register as a residue click. The hover frame
// paints the hovered residue's label (`A11`), so unhover first: a selection
// tag would survive the unhovered frame, a hover label does not.
reset()
await hoverOff()
check(texts().length === 0, `pinch leaves no residue-selection tag (texts: ${JSON.stringify(texts())})`)

// Phase 3 — ghost release: a pointerup with an untracked id (lost/cancelled
// finger) must reset the gesture state — otherwise stale `size >= 2` swallows
// every later pointermove and the canvas stops responding forever.
reset()
cv.dispatchEvent(pointer(1, 'pointerdown', 130, 100))
cv.dispatchEvent(pointer(2, 'pointerdown', 170, 100))
cv.dispatchEvent(pointer(99, 'pointerup', 140, 100))
await hoverOn()
check(
  pts().length > 0 && tip().includes('pLDDT'),
  `ghost release does not wedge the view (pts ${pts().length}, tip "${tip()}")`,
)
await hoverOff()

// Phase 4 — click-to-select still works (stationary down+up at P, zoomed view;
// pick tolerates the doubled scale since residue 11 stays within 12 px).
reset()
cv.dispatchEvent(pointer(1, 'pointerdown', P.x, P.y))
cv.dispatchEvent(pointer(1, 'pointerup', P.x, P.y))
await wait(400)
check(
  texts().some((t) => String(t).includes('A11')),
  `click-to-select still works after pinch (got "${texts().find((t) => String(t).includes('A11'))}")`,
)
await hoverOff()

// Phase 5 — single-finger rotate: drag turns yaw (offline the loop sleeps
// without state changes, so the rotated view is read via the next hover
// redraw — yaw -0.6 → ~-0.12 lengthens the projected x extent).
reset()
cv.dispatchEvent(pointer(3, 'pointerdown', 150, 150))
for (let x = 160; x <= 210; x += 25) cv.dispatchEvent(pointer(3, 'pointermove', x, 150))
cv.dispatchEvent(pointer(3, 'pointerup', 210, 150))
await hoverOn()
const rotated = extent(pts())
check(
  pts().length > 0 && rotated > zoomed + 10,
  `drag-rotate changes the projection (got ${rotated.toFixed(1)} vs zoomed ${zoomed.toFixed(1)})`,
)
await hoverOff()

console.log(failed ? 'PV PINCH FAIL' : 'PV PINCH OK')
process.exit(failed ? 1 : 0)
