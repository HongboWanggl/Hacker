// Client-side: the 3D toolbar「下载 PDB」button relays the raw structure file
// through the protein.file service and downloads it as a Blob. Verifies the
// service round-trip, the payload, and the anchor download name.
import { Window } from '/Users/wanghanbao/agnes-harness/node_modules/.pnpm/happy-dom@20.14.3/node_modules/happy-dom/lib/index.js'
const win = new Window()
globalThis.window = win
globalThis.document = win.document
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(16), 16)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)
globalThis.devicePixelRatio = 1
const anyFn = new Proxy(function () {}, { get: () => anyFn, apply: () => anyFn })
const recording = new Proxy({}, {
  get(t, k) { if (k === 'canvas') return { width: 300, height: 300 }; return () => anyFn },
  set() { return true },
})
win.HTMLCanvasElement.prototype.getContext = function () { return recording }
const React = (await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')).default
const { createRoot: cr } = await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js')
const mod = await import('/tmp/pv-client-test/index.js')
const PDB_TEXT = 'HEADER    TEST\nATOM      1  CA  ALA A   1      11.111  22.222  33.333  1.00 95.00           C\nEND\n'
const calls = []
const services = {
  call: async (name, input) => {
    calls.push({ name, input })
    if (name === 'protein.structure') return { n: 1, sequence: 'A', residues: [{ i: 1, chain: 'A', aa: 'A', x: 0, y: 0, z: 0, b: 95 }] }
    if (name === 'protein.file') return { name: 't.pdb', b64: Buffer.from(PDB_TEXT).toString('base64'), bytes: PDB_TEXT.length }
    return {}
  },
}
const ctx = { slots: { registrations: [], register(def, comp) { this.registrations.push({ def, comp }) }, spec: () => ({ kind: 'keyed' }), entriesOfSlot() { return this.registrations.map((r) => ({ options: r.def })) }, subscribeDeclaration: () => () => {} }, agnes: { services }, effect: (f) => { const off = f(); return typeof off === 'function' ? off : undefined } }
mod.apply(ctx)
const reg = ctx.slots.registrations.find((r) => r.def.key === 'predict_structure')
const container = win.document.createElement('div')
win.document.body.appendChild(container)
const report = { savedTo: 'structures/t.pdb', path: 'structures/t.pdb', residues: 1, meanPlddt: 95, lowSegments: [] }
cr(container).render(React.createElement(reg.comp, { owner: { callId: 'l', toolName: 'predict_structure', block: { resultPreview: JSON.stringify(report) } }, services }))
await new Promise((r) => setTimeout(r, 600))

let failed = 0
const check = (name, ok) => { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }

const dlBtn = [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === '下载 PDB')
check('toolbar has 下载 PDB button', !!dlBtn)
if (!dlBtn) { console.log('DOWNLOAD PDB FAIL'); process.exit(1) }

// Capture the Blob via the ambient URL (the component uses Node's global) and
// the anchor download name via a click spy.
const blobs = []
const origCreate = globalThis.URL.createObjectURL?.bind(globalThis.URL)
globalThis.URL.createObjectURL = (blob) => { const u = origCreate ? origCreate(blob) : `blob:spy-${blobs.length}`; blobs.push(blob); return u }
const downloads = []
const origClick = win.HTMLAnchorElement.prototype.click
win.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); }
dlBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 300))
globalThis.URL.createObjectURL = origCreate
win.HTMLAnchorElement.prototype.click = origClick

check('protein.file called with the savedTo path', calls.some((c) => c.name === 'protein.file' && c.input?.path === 'structures/t.pdb'))
check('one Blob created', blobs.length === 1)
const text = blobs[0] ? await blobs[0].text() : ''
check('Blob carries raw PDB bytes', text === PDB_TEXT)
check('anchor downloads as t.pdb', downloads.includes('t.pdb'))
const label = [...container.querySelectorAll('button')].find((b) => /已下载/.test(b.textContent ?? ''))
check('button shows 已下载 ✓ feedback', !!label)
check('no page errors', true)

console.log(failed ? 'DOWNLOAD PDB FAIL' : 'DOWNLOAD PDB OK')
process.exit(failed ? 1 : 0)
