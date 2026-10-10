// Verifies the ligand-pocket contact-line draw path executes: ligand atom
// within 5 Å of a residue → setLineDash([3,3]) + dashed segments beneath atoms.
import { Window } from '/Users/wanghanbao/agnes-harness/node_modules/.pnpm/happy-dom@20.14.3/node_modules/happy-dom/lib/index.js'
const win = new Window()
globalThis.window = win
globalThis.document = win.document
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(16), 16)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.devicePixelRatio = 1

// Recording 2d context: log setLineDash + segment endpoints.
const calls = []
const anyFn = new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : anyFn),
  apply: () => anyFn,
})
const recording = new Proxy({}, {
  get(t, k) {
    if (k === 'canvas') return { width: 300, height: 300 }
    return (...args) => {
      if (k === 'setLineDash' || k === 'moveTo' || k === 'lineTo') calls.push([k, ...args])
      return anyFn
    }
  },
  set() { return true },
})
win.HTMLCanvasElement.prototype.getContext = function () { return recording }

const React = (await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')).default
const { createRoot } = await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js')

const mod = await import('/tmp/pv-client-test/index.js')
const mat = Uint8Array.from([0, 90, 160, 255, 90, 0, 120, 200, 160, 120, 0, 60, 255, 200, 60, 0])
const services = {
  call: async (name, input) => {
    if (name === 'protein.structure') {
      const residues = []
      for (const chain of ['A', 'B']) {
        for (let i = 1; i <= 2; i++) residues.push({ i, chain, aa: 'A', x: i, y: 1, z: 2, b: 80 })
      }
      return {
        n: 4, sequence: 'AAAA', residues,
        // atom 0 sits 1.5 Å from residue (1,1,2), atom 1 far from all
        ligandAtoms: [{ el: 'C', x: 2.5, y: 1, z: 2 }, { el: 'O', x: 50, y: 50, z: 50 }],
        ligandBonds: [[0, 1]],
      }
    }
    if (name === 'protein.pae' && input.path === 'structures/x_pae.npz') {
      return { n: 4, data: Buffer.from(mat).toString('base64') }
    }
    throw new Error('unexpected ' + name)
  },
}
const ctx = { slots: { registrations: [], register(def, comp) { this.registrations.push({ def, comp }) }, spec: () => ({ kind: 'keyed' }), entriesOfSlot() { return this.registrations.map((r) => ({ options: r.def })) }, subscribeDeclaration: () => () => {} }, agnes: { services }, effect: (f) => { const off = f(); return typeof off === 'function' ? off : undefined } }
mod.apply(ctx)
const complexReg = ctx.slots.registrations.find((r) => r.def.key === 'predict_complex')
const report = {
  predictionId: 'pred_c', savedTo: 'structures/complex_boltz.pdb', chains: 2, hasLigand: true, residues: 4,
  ptm: 88.1, iptm: 82.5, bindingConfidence: 87.3, verdict: 'high confidence', paePath: 'structures/x_pae.npz',
}
const container = win.document.createElement('div')
win.document.body.appendChild(container)
createRoot(container).render(React.createElement(complexReg.comp, { owner: { callId: 'c', toolName: 'predict_complex', block: { resultPreview: JSON.stringify(report) } }, services }))
await new Promise((r) => setTimeout(r, 600))

let failed = 0
const check = (name, ok) => { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }
const dashCalls = calls.filter((c) => c[0] === 'setLineDash' && c[1].length === 2 && c[1][0] === 3 && c[1][1] === 3)
check('dashed mode engaged (setLineDash [3,3])', dashCalls.length > 0)
check('dash reset after contacts', calls.some((c) => c[0] === 'setLineDash' && c[1].length === 0))
// Walk every [3,3]→[] window (heatmap/strip chain-boundary dashes share the
// pattern, and all canvases record into one array): the contact-line window is
// the one with 4 segments — residues (1,1,2)/(2,1,2) × chains A/B all sit
// within 5 Å of ligand atom 0.
const windows = []
for (let i = 0; i < calls.length; i++) {
  const c = calls[i]
  if (c[0] === 'setLineDash' && c[1].length === 2 && c[1][0] === 3 && c[1][1] === 3) {
    let j = i + 1
    while (j < calls.length && !(calls[j][0] === 'setLineDash' && calls[j][1].length === 0)) j++
    windows.push(calls.slice(i, j).filter((x) => x[0] === 'lineTo').length)
    i = j
  }
}
check(`contact segments drawn beneath atoms (windows: ${windows.join(',')})`, windows.includes(4))

// 3D pick on a ligand atom: replicate the draw projection (initial yaw/pitch,
// centroid of the Cαs, radius over residues+ligand) and hover the far O atom.
// Must run within 2.5 s of mount — after that auto-spin starts drifting yaw.
{
  const A = { x: 50, y: 50, z: 50 } // far O atom, ligandAtoms[1]
  const c = [1.5, 1, 2] // centroid of the four Cαs
  const l = [A.x - c[0], A.y - c[1], A.z - c[2]]
  const maxR = Math.hypot(...l)
  const yaw = -0.6
  const pitch = 0.35
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const scale = (300 * 0.42 * 1) / maxR
  const x1 = l[0] * cy + l[2] * sy
  const z1 = -l[0] * sy + l[2] * cy
  const y1 = l[1] * cp - z1 * sp
  const cv = container.querySelector('canvas.pv-3d')
  check('3D canvas present for pick test', !!cv)
  cv.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 300 })
  cv.dispatchEvent(new win.MouseEvent('pointermove', { bubbles: true, clientX: 150 + x1 * scale, clientY: 150 + y1 * scale }))
  await new Promise((r) => setTimeout(r, 120))
  const ligReadout = [...container.querySelectorAll('.pv-hoverline')].map((e) => e.textContent).find((t) => t.includes('配体原子')) ?? ''
  check(`ligand atom hover readout (got "${ligReadout}")`, ligReadout === '配体原子 O · 距最近残基 A:A2 83.7 Å')
  cv.dispatchEvent(new win.MouseEvent('pointerleave', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 80))
}

// hover readout gains the ligand distance for pocket residues: strip row 1 →
// residues[1] = A:A2 at (2,1,2), 0.5 Å from ligand atom 0 at (2.5,1,2).
const strip = container.querySelector('canvas.pv-pae-strip')
check('strip canvas present for hover test', !!strip)
strip.getBoundingClientRect = () => ({ left: 0, top: 0, width: 28, height: 100 })
strip.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 30 }))
await new Promise((r) => setTimeout(r, 200))
const readout = [...container.querySelectorAll('.pv-hoverline')].map((e) => e.textContent).find((t) => t.includes('pLDDT')) ?? ''
check(`pocket readout shows ligand distance (got "${readout}")`, readout === 'A:A2 · pLDDT 80.0 · 距配体 0.5 Å')

// curve CSV gains the interface_pae column when PAE is present: stub
// createObjectURL, click 导出 CSV, inspect the blob text.
let csvBlob = null
URL.createObjectURL = (b) => ((csvBlob = b), 'blob:mock')
const csvBtn = [...container.querySelectorAll('button.pv-export')].find((b) => b.textContent === '导出 CSV')
csvBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 100))
const csvText = csvBlob ? await csvBlob.text() : ''
check(`CSV header carries interface_pae (got "${csvText.split('\n')[0]}")`, csvText.startsWith('residue,aa,plddt,interface_pae\n'))
// residue 0 row: i=0 cross-chain cells are 160,255 → mean 207.5 → 26.04 Å
check(`CSV row carries interface PAE (got "${csvText.split('\n')[1]}")`, csvText.split('\n')[1] === 'A:1,A,80.0,26.04')
process.exit(failed ? 1 : 0)
console.log('CONTACT LINE TESTS DONE')
