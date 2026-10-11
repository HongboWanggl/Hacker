// Client-side: segment focus reaches the 3D view — residues outside the
// focused segment draw with the dim bond color `rgba(120,130,150,0.25)`,
// driven by the jump box ("3-6") exactly like the low-confidence chips.
// Uses a recording canvas context to capture strokeStyle per stroke.
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
// Canvas guard BEFORE mount: draw effects run on mount, before we attach the
// recording contexts (same trick as pv-drag-range).
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

const DIM = 'rgba(120,130,150,0.25)'

// Recording 2D context: logs strokeStyle on every stroke() so the dimmed
// bonds are detectable without pixel access.
function recordingCtx() {
  const t = { canvas: null, __strokes: [], __texts: [] }
  return new Proxy(t, {
    get(target, prop) {
      if (prop === 'stroke') return () => void target.__strokes.push(target.strokeStyle)
      if (prop === 'fill') return () => void target.__strokes.push(null)
      if (prop === 'fillText') return (txt) => void target.__texts.push(txt)
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

// Gentle zig-zag keeps consecutive Cα at ~3.8 Å so the 4.5 Å bond gate
// actually produces bonds (a tight helix pitches past the gate). b = 55+i puts
// the mean at 64.5 — clear of the 90/70/50 grid lines so the μ line draws.
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
      callId: 'd-seg3d',
      toolName: 'predict_structure',
      block: { resultPreview: JSON.stringify(report(20, 'seg3d')) },
    },
    services,
  }),
)
await new Promise((r) => setTimeout(r, 500))

// Attach recording contexts to every canvas before the redraws below (the
// mount draw already happened with a noop ctx — we only compare from here on).
for (const cv of container.querySelectorAll('canvas')) {
  const rc = recordingCtx()
  rc.__strokes = []
  cv.getContext = () => rc
}

const dimCount = () => {
  const cv = container.querySelector('canvas.pv-3d')
  return cv.getContext().__strokes.filter((s) => s === DIM).length
}
const allStrokes = () => {
  const cv = container.querySelector('canvas.pv-3d')
  return cv.getContext().__strokes
}
// Recording contexts accumulate; reset between phases so counts reflect the
// latest redraw only.
const resetStrokes = () => {
  for (const cv of container.querySelectorAll('canvas')) cv.getContext().__strokes.length = 0
}

// Baseline: canvas exists; the static panel draws once on mount and sleeps, so
// meaningful stroke assertions start once the focus triggers a redraw.
await new Promise((r) => setTimeout(r, 400))
check(!!container.querySelector('canvas.pv-3d'), '3D canvas mounted')

// Type a range in the jump box and press Enter → segment focus.
const jump = container.querySelector('.pv-jump')
jump.value = '3-6'
jump.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
await new Promise((r) => setTimeout(r, 400))
const during = dimCount()
check(during > 0, `dim bonds appear while segment 3-6 is focused (got ${during})`)

// Segment strokes recorded, and normal colored bonds still drawn too.
check(
  allStrokes().some((s) => s && s !== DIM),
  'in-segment bonds keep their colored strokes',
)

// Re-entering the same range clears the focus → dim bonds disappear.
resetStrokes()
jump.value = '3-6'
jump.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
await new Promise((r) => setTimeout(r, 400))
const after = dimCount()
check(after === 0, `clearing the focus removes dim bonds (got ${after})`)
check(allStrokes().length > 0, `canvas still draws normally after clearing (${allStrokes().length} strokes)`)

// The 聚焦区段 chip is a button — clicking it clears the focus too.
resetStrokes()
jump.value = '3-6'
jump.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
await new Promise((r) => setTimeout(r, 300))
const chip = container.querySelector('button.pv-fmt--clear')
check(!!chip, 'focus chip renders as a clearable button')
resetStrokes() // drop the focused draw's dim strokes; only the post-click redraw counts
chip?.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
await new Promise((r) => setTimeout(r, 300))
check(dimCount() === 0, `clicking the focus chip clears the focus (got ${dimCount()} dim strokes)`)

// --- batch drill-down: strip drag-select must drive the same 3D fade
{
  const bctx = mkCtx()
  const bservices = {
    call: async () => {
      const residues = mkResidues(20)
      return { n: residues.length, sequence: 'A'.repeat(residues.length), residues }
    },
  }
  bctx.agnes = { services: bservices }
  mod.apply(bctx)
  const breg = bctx.slots.registrations.find((r) => r.def.key === 'batch_predict')
  const breport = {
    summary: { ok: 1, failed: 0, meanPlddt: 70 },
    jobs: [
      {
        accession: 'P61626',
        name: 'Lysozyme C',
        status: 'ok',
        residues: 20,
        meanPlddt: 70,
        lowSegments: 0,
        savedTo: 'structures/lyz.pdb',
      },
    ],
  }
  const bcontainer = win.document.createElement('div')
  win.document.body.appendChild(bcontainer)
  createRoot(bcontainer).render(
    React.createElement(breg.comp, {
      owner: {
        callId: 'd-seg3d-b',
        toolName: 'batch_predict',
        block: { resultPreview: JSON.stringify(breport) },
      },
      services: bservices,
    }),
  )
  await new Promise((r) => setTimeout(r, 500))

  // Expand the row → drill-down mounts (3D + curve + strip).
  const row = bcontainer.querySelector('.pv-batch-row--ok')
  row.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
  await new Promise((r) => setTimeout(r, 500))

  const bcv = bcontainer.querySelector('canvas.pv-3d')
  check(!!bcv, 'drill-down mounts its own 3D canvas')
  // Attach a recording context for the redraw triggered by the focus.
  const brc = recordingCtx()
  brc.__strokes = []
  bcv.getContext = () => brc

  const btiles = [...bcontainer.querySelectorAll('.pv-seq-tile')]
  check(btiles.length === 20, `drill-down strip mounted with tiles (got ${btiles.length})`)
  const bmouse = (el, type) =>
    el.dispatchEvent(
      new win.MouseEvent(type === 'mouseenter' ? 'mouseover' : type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === 'mouseup' ? 0 : 1,
      }),
    )
  bmouse(btiles[5], 'mousedown')
  bmouse(btiles[8], 'mouseenter')
  bmouse(btiles[12], 'mouseenter')
  bmouse(btiles[12], 'mouseup')
  await new Promise((r) => setTimeout(r, 400))
  const bdims = brc.__strokes.filter((s) => s === DIM).length
  check(bdims > 0, `drill-down drag-select fades out-of-segment 3D bonds (got ${bdims} dim strokes)`)
  check(
    brc.__strokes.some((s) => s && s !== DIM),
    'drill-down in-segment bonds keep their colors',
  )

  // The drill-down jump box: a range drives the same focus (label + dim 3D),
  // re-entering clears it, and a plain residue jump still selects.
  const bjump = bcontainer.querySelector('.pv-jump')
  check(!!bjump, 'drill-down exposes a jump box')
  bjump.value = '3-6'
  bjump.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await new Promise((r) => setTimeout(r, 300))
  check(
    (bcontainer.querySelector('.pv-fmt')?.textContent ?? '').includes('聚焦区段 3–6'),
    `drill-down jump range shows 聚焦区段 3–6 (got "${bcontainer.querySelector('.pv-fmt')?.textContent}")`,
  )
  bjump.value = '3-6'
  bjump.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await new Promise((r) => setTimeout(r, 300))
  check(!bcontainer.querySelector('.pv-fmt'), 'drill-down re-entering the range clears the focus')
  bjump.value = '9'
  bjump.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await new Promise((r) => setTimeout(r, 300))
  const bhover = bcontainer.querySelector('.pv-hoverline')?.textContent ?? ''
  check(bhover.includes('A9'), `drill-down residue jump selects A9 (got "${bhover.slice(0, 40)}")`)

  // Curve draws a mean reference line ("μ64.5") — headline number visible in
  // the plot, not just the summary.
  const cvTexts = () => {
    const cv = container.querySelector('canvas.pv-curve')
    return cv.getContext().__texts.map(String)
  }
  check(
    cvTexts().some((t) => t.startsWith('μ')),
    `curve draws the mean line tag (got [${cvTexts().filter((t) => t.startsWith('μ'))}])`,
  )

  // Color mode dropdown: single-chain default is pLDDT; switching to rainbow
  // swaps the legend (same dropdown as the main panel).
  const bsel = bcontainer.querySelector('.pv-batch-detail .pv-select')
  check(!!bsel, 'drill-down exposes the color mode dropdown')
  const legendNote = () =>
    [...bcontainer.querySelectorAll('.pv-legend-note')].map((n) => n.textContent).join('|')
  check(legendNote().includes('pLDDT'), `default legend is pLDDT (got "${legendNote()}")`)
  // React tracks select.value through its own descriptor — set via the native
  // setter so the change event carries the new value into React's onChange.
  Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value').set.call(bsel, 'rainbow')
  bsel.dispatchEvent(new win.Event('change', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 200))
  check(legendNote().includes('N→C'), `rainbow legend appears after switch (got "${legendNote()}")`)

  // Auto-rotate toggle: off by default; React fires onChange on click for
  // checkboxes — dispatch a real click and the controlled input stays flipped.
  const spin = bcontainer.querySelector('.pv-batch-detail .pv-toggle input[type=checkbox]')
  check(!!spin && !spin.checked, 'drill-down auto-rotate toggle present, off by default')
  spin.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
  await new Promise((r) => setTimeout(r, 200))
  check(spin.checked, 'drill-down auto-rotate click toggles on (controlled input kept it)')
  bcontainer.remove()
}

console.log(failed ? 'SEG 3D FAIL' : 'SEG 3D OK')
process.exit(failed ? 1 : 0)
