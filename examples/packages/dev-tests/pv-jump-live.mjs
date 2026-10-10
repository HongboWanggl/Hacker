// Client-side test: confidence panel toolbar mounts jump box; typing a residue
// number + Enter highlights it (hoverline text updates). Multi-chain panels
// also accept a chain prefix ("B:5") to disambiguate per-chain numbering.
import { Window } from '/Users/wanghanbao/agnes-harness/node_modules/.pnpm/happy-dom@20.14.3/node_modules/happy-dom/lib/index.js'
const win = new Window()
globalThis.window = win
globalThis.document = win.document
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(16), 16)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.devicePixelRatio = 1
const anyFn = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => 0 : anyFn), apply: () => anyFn })
win.HTMLCanvasElement.prototype.getContext = () => anyFn
win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,x'

const React = (await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')).default
const { createRoot } = await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js')
const mod = await import('/tmp/pv-client-test/index.js')

const ok = (name, cond) => { console.log(cond ? 'ok ' : 'FAIL', name); if (!cond) process.exitCode = 1 }

async function run(services, report) {
  const ctx = { slots: { registrations: [], register(def, comp) { this.registrations.push({ def, comp }) }, spec: () => ({ kind: 'keyed' }), entriesOfSlot() { return this.registrations.map((r) => ({ options: r.def })) }, subscribeDeclaration: () => () => {} }, agnes: { services }, effect: (f) => { const off = f(); return typeof off === 'function' ? off : undefined } }
  mod.apply(ctx)
  const reg = ctx.slots.registrations.find((r) => r.def.key === 'predict_structure')
  const container = win.document.createElement('div')
  win.document.body.appendChild(container)
  createRoot(container).render(React.createElement(reg.comp, { owner: { callId: 'j', toolName: 'predict_structure', block: { resultPreview: JSON.stringify(report) } }, services }))
  await new Promise((r) => setTimeout(r, 500))
  const input = container.querySelector('.pv-jump')
  const set = (v) => { const s = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value').set; s.call(input, v) }
  const jump = async (v) => {
    set(v)
    input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    return container.querySelector('.pv-hoverline')?.textContent ?? ''
  }
  return { container, jump }
}

// --- pass 1: single chain (regression: bare numbers)
{
  const services = { call: async (_name, { path }) => {
    const residues = []
    for (let i = 1; i <= 40; i++) residues.push({ i, aa: 'A', x: i * 3.8 - 80, y: Math.sin(i) * 5, z: Math.cos(i) * 5, b: 40 + i })
    return { n: 40, sequence: 'A'.repeat(40), residues }
  } }
  const report = { residues: 40, meanPlddt: 60, bands: {}, lowConfidenceSegments: [], savedTo: 'structures/x_40aa.pdb' }
  const { container, jump } = await run(services, report)
  const html = container.innerHTML
  ok('jump box mounted', html.includes('pv-jump'))
  ok('export buttons mounted', container.querySelectorAll('.pv-export').length === 2)
  // sequence strip: one band-colored tile per residue
  ok('sequence strip renders 40 tiles', container.querySelectorAll('.pv-seq-tile').length === 40)
  const tile17 = container.querySelectorAll('.pv-seq-tile')[16]
  ok('tile shows single-letter code', tile17.textContent === 'A')
  tile17.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 200))
  ok('clicking tile selects residue', (container.querySelector('.pv-hoverline')?.textContent ?? '').includes('A17'))
  const line = await jump('17')
  ok('hoverline shows residue 17 after jump', line.includes('A17') && line.includes('57.0'))
  const lineAa = await jump('A18')
  ok('aa+number jump (A18) targets residue 18', lineAa.includes('A18'))
  const lineMiss = await jump('W99')
  ok('aa mismatch keeps last selection', lineMiss.includes('A18'))
  await jump('17') // resync for the keyboard block below
  const line2 = await jump('999')
  ok('unknown residue keeps last selection', line2.includes('A17'))
  // keyboard: ←/→ steps the selection along the residues
  const key = (k) => {
    container.querySelector('.pv-root').dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
  }
  key('ArrowRight')
  await new Promise((r) => setTimeout(r, 200))
  ok('ArrowRight steps to 18', (container.querySelector('.pv-hoverline')?.textContent ?? '').includes('A18'))
  key('ArrowLeft')
  key('ArrowLeft')
  await new Promise((r) => setTimeout(r, 200))
  ok('ArrowLeft steps back to 16', (container.querySelector('.pv-hoverline')?.textContent ?? '').includes('A16'))
  await jump('1')
  key('ArrowLeft')
  await new Promise((r) => setTimeout(r, 200))
  ok('ArrowLeft clamps at first residue', (container.querySelector('.pv-hoverline')?.textContent ?? '').includes('A1'))
  container.remove()
}

// --- pass 2: two chains both numbered 1-10 (Boltz-2 complex shape)
{
  const services = { call: async () => {
    const residues = []
    for (let i = 1; i <= 10; i++) residues.push({ i, chain: 'A', aa: 'A', x: i * 3.8 - 40, y: Math.sin(i) * 5, z: Math.cos(i) * 5, b: 60 + i })
    for (let i = 1; i <= 10; i++) residues.push({ i, chain: 'B', aa: 'G', x: i * 3.8 - 20, y: Math.cos(i) * 5, z: Math.sin(i) * 5, b: 30 + i })
    return { n: 20, sequence: 'A'.repeat(10) + 'G'.repeat(10), residues }
  } }
  const report = { residues: 20, meanPlddt: 55, bands: {}, lowConfidenceSegments: [], savedTo: 'structures/cplx_20aa.pdb' }
  const { container, jump } = await run(services, report)
  ok('multi-chain placeholder hints chain syntax', container.innerHTML.includes('B:17…'))
  ok('chain legend auto-shown', (container.innerHTML.match(/pv-chain-chip/g) ?? []).length === 2)
  ok('sequence strip renders 20 tiles', container.querySelectorAll('.pv-seq-tile').length === 20)
  const tileB1 = container.querySelectorAll('.pv-seq-tile')[10]
  ok('chain break gets a gap in the strip', tileB1.style.marginLeft === '5px' && tileB1.textContent === 'G')
  const line = await jump('B:5')
  ok('chain-prefixed jump targets chain B', line.includes('B:G5') && line.includes('35.0'))
  const line2 = await jump('5')
  ok('bare number still matches first chain', line2.includes('A:A5') && line2.includes('65.0'))
  container.remove()
}

console.log('JUMP TESTS DONE')
process.exit(process.exitCode ?? 0)
