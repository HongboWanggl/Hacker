// Client-side render (effects run) for the PaesModule path: fake protein.pae
// service feeds a 4×4 matrix; checks canvas mount, hover readout, and export
// buttons. Run via run-all.sh (cwd = dev-tests).
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
// 4×4 matrix, row-major bytes: diag ~0 (confident), off-diag larger.
const mat = Uint8Array.from([0, 90, 160, 255, 90, 0, 120, 200, 160, 120, 0, 60, 255, 200, 60, 0])
const services = {
  call: async (name, input) => {
    if (name === 'protein.structure') {
      const residues = []
      for (const chain of ['A', 'B']) {
        for (let i = 1; i <= 2; i++) residues.push({ i, chain, aa: 'A', x: i, y: 1, z: 2, b: 80 })
      }
      return {
        n: 4,
        sequence: 'AAAA',
        residues,
        ligandAtoms: [
          { el: 'C', x: 9, y: 9, z: 9 },
          { el: 'O', x: 10.1, y: 9, z: 9 },
        ],
        ligandBonds: [[0, 1]],
      }
    }
    if (name === 'protein.pae') {
      if (input.path === 'structures/pooled_pae.npz') {
        return { n: 2, data: Buffer.from(pooled).toString('base64'), scale: 2 }
      }
      if (input.path === 'structures/x_pae.npz') return { n: 4, data: Buffer.from(mat).toString('base64') }
      throw new Error(`unexpected pae path ${input.path}`)
    }
    throw new Error(`unexpected ${name}`)
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
  residues: 4,
  ptm: 88.1,
  iptm: 82.5,
  bindingConfidence: 87.3,
  verdict: 'predicted to bind with high confidence',
  paePath: 'structures/x_pae.npz',
}
const container = win.document.createElement('div')
win.document.body.appendChild(container)
createRoot(container).render(
  React.createElement(complexReg.comp, {
    owner: { callId: 'c-pae', toolName: 'predict_complex', block: { resultPreview: JSON.stringify(report) } },
    services,
  }),
)
await new Promise((r) => setTimeout(r, 500))

let failed = 0
const check = (name, ok) => {
  console.log(ok ? 'ok ' : 'FAIL', name)
  if (!ok) failed++
}
const _html = container.innerHTML
check('PAE module mounts with canvas', !!container.querySelector('canvas.pv-pae-canvas'))
// n=4 upscales at cell=8 → 32×32 display canvas (nearest-neighbour, by design)
check('canvas upscaled to 32×32', container.querySelector('canvas.pv-pae-canvas')?.width === 32)
check('legend bar present', !!container.querySelector('.pv-pae-legendbar'))
check(
  'export PNG button',
  [...container.querySelectorAll('.pv-pae button.pv-export')].some((b) => b.textContent === '导出 PNG'),
)
check(
  'export CSV button',
  [...container.querySelectorAll('.pv-pae button.pv-export')].some((b) => b.textContent === '导出 CSV'),
)
check('caption present', container.querySelector('.pv-pae-caption')?.textContent.includes('链边界') ?? false)
// chain-pair mean chips: A={0,1}, B={2,3}; cross cells 160,255,120,200 →
// mean 183.75 → 23.06 Å
const pairChip = container.querySelector('.pv-pae-pair')?.textContent ?? ''
check(`chain-pair mean chip (got "${pairChip}")`, pairChip === 'A–B 23.06 Å')
// chips are toggle buttons: clicking focuses the pair (block outline in the
// heatmap), clicking again clears it
const chipBtn = container.querySelector('.pv-pae-pair')
chipBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 200))
const chipOn = container.querySelector('.pv-pae-pair')?.className ?? ''
check('chip click focuses pair', chipOn.includes('pv-pae-pair--on'))
container.querySelector('.pv-pae-pair').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 200))
const chipOff = container.querySelector('.pv-pae-pair')?.className ?? ''
check('second chip click clears focus', !chipOff.includes('pv-pae-pair--on'))
// PaesModule lifts per-residue inter-chain means to the parent → the 3D
// color-by select gains the interface option on complex panels
check('interface color mode offered', !!container.querySelector('select.pv-select option[value=interface]'))
// ligand toggle appears when the structure carries HETATM atoms
const ligLabel =
  [...container.querySelectorAll('.pv-toggle')].map((l) => l.textContent).find((t) => t.includes('配体')) ??
  ''
check(`ligand toggle counts atoms (got "${ligLabel}")`, ligLabel === '配体 (2)')

// side profile strip: one bar per row = mean PAE against other residues.
// Tested before the heatmap hover (no mouseleave in happy-dom → hoverCell
// would otherwise stick and win the readout priority).
const strip = container.querySelector('canvas.pv-pae-strip')
check('strip canvas present, sized to heatmap', !!strip && strip.width === 28 && strip.height === 32)
strip.getBoundingClientRect = () => ({ left: 0, top: 0, width: 28, height: 100 })
// row 1 = A:A2; bytes [90,0,120,200] minus self → (90+120+200)/3 = 136.67 → 17.15 Å
strip.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 30 }))
await new Promise((r) => setTimeout(r, 200))
const stripReadout = container.querySelector('.pv-pae-side .pv-hoverline')?.textContent ?? ''
check(`strip hover mean readout (got "${stripReadout}")`, stripReadout === 'A:A2 · 平均 17.15 Å')

// hover readout: stub rect (0,0,100,100), n=4 → 25 px cells. clientX 37.5 →
// i=1, clientY 62.5 → j=2 (62.5/25 = 2.5) → byte 120 → "A:A2 → B:A1 · 15.06 Å".
// The pair readout takes priority over the strip mean once the heatmap is hovered.
const canvas = container.querySelector('canvas.pv-pae-canvas')
canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 })
canvas.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 37.5, clientY: 62.5 }))
await new Promise((r) => setTimeout(r, 200))
const readout = container.querySelector('.pv-pae-side .pv-hoverline')?.textContent ?? ''
check(`hover readout cell(1,2) (got "${readout}")`, readout === 'A:A2 → B:A1 · 15.06 Å')

// --- keyboard navigation: the heatmap canvas is focusable, arrows move the
// readout cell (same signals as the mouse: readout + cross-view linkage) ---
// happy-dom never fires mouseleave (known probe trap) — clear the sticky
// hoverCell first so the keyboard cursor owns the readout.
canvas.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true, relatedTarget: win.document.body }))
await new Promise((r) => setTimeout(r, 150))
const kbdChecks = []
kbdChecks.push([
  'canvas is focusable with keyboard hints in its label',
  canvas.tabIndex === 0 && (canvas.getAttribute('aria-label') ?? '').includes('方向键'),
])
// Focus starts the cursor at {0,0} (no hover cell anymore).
canvas.focus()
await new Promise((r) => setTimeout(r, 200))
const kbReadout0 = container.querySelector('.pv-pae-side .pv-hoverline')?.textContent ?? ''
kbdChecks.push([`focus starts cursor at origin (got "${kbReadout0}")`, kbReadout0 === 'A:A1 → A:A1 · 0.00 Å'])
const key = (k) =>
  canvas.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
const kbReadout = async () => {
  await new Promise((r) => setTimeout(r, 150))
  return container.querySelector('.pv-pae-side .pv-hoverline')?.textContent ?? ''
}
key('ArrowRight')
kbdChecks.push([
  `ArrowRight steps column (got "${await kbReadout()}")`,
  (await kbReadout()) === 'A:A2 → A:A1 · 11.29 Å',
])
key('ArrowDown')
kbdChecks.push([
  `ArrowDown steps row (got "${await kbReadout()}")`,
  (await kbReadout()) === 'A:A2 → A:A2 · 0.00 Å',
])
key('Home')
kbdChecks.push([
  `Home jumps to first column (got "${await kbReadout()}")`,
  (await kbReadout()) === 'A:A1 → A:A2 · 11.29 Å',
])
key('End')
kbdChecks.push([
  `End jumps to last column (got "${await kbReadout()}")`,
  (await kbReadout()) === 'B:A2 → A:A2 · 25.10 Å',
])
key('ArrowLeft')
kbdChecks.push([
  `ArrowLeft steps back (got "${await kbReadout()}")`,
  (await kbReadout()) === 'B:A1 → A:A2 · 15.06 Å',
])
key('Escape')
kbdChecks.push([
  `Escape blurs and the cursor clears (got "${await kbReadout()}")`,
  (await kbReadout()) === 'A:A2 · 平均 17.15 Å',
])
for (const [name, ok] of kbdChecks) {
  console.log(ok ? 'ok ' : 'FAIL', name)
  if (!ok) failed++
}

// --- click-to-pin: the readout survives mouse-leave; second click releases ---
// Rect stub is {0,0,100,100}, n=4 → 25 px cells; click at (37.5, 62.5) = cell (1,2).
const pinChecks = []
const clickCell = (cx, cy) =>
  canvas.dispatchEvent(new win.MouseEvent('click', { bubbles: true, clientX: cx, clientY: cy }))
clickCell(37.5, 62.5)
pinChecks.push([
  `click pins the cell readout (got "${await kbReadout()}")`,
  (await kbReadout()) === 'A:A2 → B:A1 · 15.06 Å',
])
// Mouse leaves (hover cleared) — the pin must keep the pair on the readout.
canvas.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true, relatedTarget: win.document.body }))
pinChecks.push([
  `pinned readout survives mouse-leave (got "${await kbReadout()}")`,
  (await kbReadout()) === 'A:A2 → B:A1 · 15.06 Å',
])
clickCell(37.5, 62.5)
pinChecks.push([
  `second click releases the pin (got "${await kbReadout()}")`,
  (await kbReadout()) === 'A:A2 · 平均 17.15 Å',
])

// --- keyboard pin: Enter fixes the cursor cell, survives Esc-blur ---
canvas.focus()
await new Promise((r) => setTimeout(r, 150))
key('ArrowRight') // cursor → (1,0)
await new Promise((r) => setTimeout(r, 150)) // let the cursor render before pinning
key('Enter')
pinChecks.push([
  `Enter pins the cursor cell (got "${await kbReadout()}")`,
  (await kbReadout()) === 'A:A2 → A:A1 · 11.29 Å',
])
key('Escape') // blur — pin must survive
pinChecks.push([
  `pinned readout survives Esc-blur (got "${await kbReadout()}")`,
  (await kbReadout()) === 'A:A2 → A:A1 · 11.29 Å',
])
canvas.focus() // cursor re-initializes on the pinned cell
await new Promise((r) => setTimeout(r, 150))
pinChecks.push([
  `refocus starts cursor at the pin (got "${await kbReadout()}")`,
  (await kbReadout()) === 'A:A2 → A:A1 · 11.29 Å',
])
key('Enter') // releases the pin — but the keyboard cursor still owns the readout
key('Escape') // blur clears the cursor too; only then the strip mean returns
pinChecks.push([
  `Enter on the pinned cell releases it (got "${await kbReadout()}")`,
  (await kbReadout()) === 'A:A2 · 平均 17.15 Å',
])
for (const [name, ok] of pinChecks) {
  console.log(ok ? 'ok ' : 'FAIL', name)
  if (!ok) failed++
}

// --- pooled matrix (scale > 1): labels become residue ranges ----------------
const pooled = Uint8Array.from([0, 255, 64, 128])
const container2 = win.document.createElement('div')
win.document.body.appendChild(container2)
// Same slot component binds its own ctx services — the mock above dispatches
// on input.path, so this render just uses a different paePath.
createRoot(container2).render(
  React.createElement(complexReg.comp, {
    owner: {
      callId: 'c-pool',
      toolName: 'predict_complex',
      block: { resultPreview: JSON.stringify({ ...report, paePath: 'structures/pooled_pae.npz' }) },
    },
  }),
)
await new Promise((r) => setTimeout(r, 500))
const html2 = container2.innerHTML
check('pooled title notes scale', html2.includes('每格 2 残基'))
// pooled chain-pair chip: cross cells 255,64 → mean 159.5 → 20.02 Å
const pairChip2 = container2.querySelector('.pv-pae-pair')?.textContent ?? ''
check(`pooled chain-pair chip (got "${pairChip2}")`, pairChip2 === 'A–B 20.02 Å')
const canvas2 = container2.querySelector('canvas.pv-pae-canvas')
check('pooled canvas 2×2 native (upscaled 16×16)', canvas2?.width === 16)
// pooled strip: row 0 mean excluding self = byte 255 → 32.00 Å, range label
const strip2 = container2.querySelector('canvas.pv-pae-strip')
check('pooled strip present', !!strip2 && strip2.height === 16)
strip2.getBoundingClientRect = () => ({ left: 0, top: 0, width: 28, height: 100 })
strip2.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 20 }))
await new Promise((r) => setTimeout(r, 200))
const stripReadout2 = container2.querySelector('.pv-pae-side .pv-hoverline')?.textContent ?? ''
check(`pooled strip range readout (got "${stripReadout2}")`, stripReadout2 === 'A:A1–A:A2 · 平均 32.00 Å')
canvas2.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 })
// cell (1,0): n=2 → 50px cells; clientX 62.5 → i=1, clientY 12.5 → j=0.
// cell(1) covers residues[2..3] = B:A1–B:A2; byte pooled[2]=64 → 8.03 Å.
canvas2.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 62.5, clientY: 12.5 }))
await new Promise((r) => setTimeout(r, 200))
const readout2 = container2.querySelector('.pv-pae-side .pv-hoverline')?.textContent ?? ''
check(`pooled hover readout ranges (got "${readout2}")`, readout2 === 'B:A1–B:A2 → A:A1–A:A2 · 8.03 Å')

// fullscreen toggle: the module pins fixed and the matrix cell cap lifts
// (4×4 native → cell 8 inline, 24 maximized), Esc exits.
const maxChecks = []
const paeRoot = container.querySelector('.pv-pae')
const fsBtn = [...paeRoot.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes('全屏'))
maxChecks.push(['fullscreen button rendered', !!fsBtn])
if (fsBtn && paeRoot) {
  const w0 = container.querySelector('canvas.pv-pae-canvas').width
  fsBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
  const w1 = container.querySelector('canvas.pv-pae-canvas').width
  maxChecks.push([
    `matrix grows maximized (32 → ${w1})`,
    paeRoot.className.includes('pv-pae--max') && w1 > w0,
  ])
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
  maxChecks.push(['Escape exits maximized PAE', !paeRoot.className.includes('pv-pae--max')])
}
for (const [name, ok] of maxChecks) {
  console.log(ok ? 'ok ' : 'FAIL', name)
  if (!ok) failed++
}

// PAE copy-image: the composited export figure (title + heatmap + profile
// strip + legend) goes to the clipboard; button lives in the PAE toolbar.
const copyChecks = []
let clipItems = null
globalThis.ClipboardItem = class {
  constructor(items) {
    this.items = items
    clipItems = items
  }
}
win.HTMLCanvasElement.prototype.toBlob = (cb) => cb(new Blob(['pngbytes'], { type: 'image/png' }))
const paeWrites = []
try {
  Object.defineProperty(win.navigator, 'clipboard', {
    value: { write: async (items) => paeWrites.push(items) },
    configurable: true,
  })
} catch {}
const paeCopyBtn = [...(container.querySelector('.pv-pae')?.querySelectorAll('button.pv-export') ?? [])].find(
  (b) => (b.textContent ?? '').trim() === '复制图像',
)
copyChecks.push(['PAE copy-image button rendered', !!paeCopyBtn])
if (paeCopyBtn) {
  paeCopyBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
  copyChecks.push([
    'PAE clipboard write receives image/png',
    !!clipItems && clipItems['image/png'] instanceof Blob && clipItems['image/png'].type === 'image/png',
  ])
  copyChecks.push(['PAE button confirms copy', (paeCopyBtn.textContent ?? '').includes('已复制')])
}
for (const [name, ok] of copyChecks) {
  console.log(ok ? 'ok ' : 'FAIL', name)
  if (!ok) failed++
}
process.exit(failed ? 1 : 0)
console.log('PAE PANEL TESTS DONE')
