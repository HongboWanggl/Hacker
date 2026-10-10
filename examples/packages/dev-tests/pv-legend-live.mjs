// Client-side test: the 3D view mounts a color-scale legend for the non-chain
// colorings (pLDDT bands / rainbow N→C), and the PNG export composites the
// matching scale row so every figure is self-explanatory.
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
// Recording 2d context: log fillText/fillRect for the export composite checks.
const calls = []
const recording = new Proxy({}, {
  get(t, k) {
    if (k === 'canvas') return { width: 300, height: 300 }
    return (...args) => {
      if (k === 'fillText' || k === 'fillRect') calls.push([k, ...args])
      return anyFn
    }
  },
  set() { return true },
})
win.HTMLCanvasElement.prototype.getContext = function () { return recording }
win.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,'

const React = (await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')).default
const { createRoot } = await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js')
const mod = await import('/tmp/pv-client-test/index.js')

let failed = 0
const check = (name, cond) => { console.log(cond ? 'ok ' : 'FAIL', name); if (!cond) failed++ }
const mk = (n) => Array.from({ length: n }, (_, i) => ({ i: i + 1, aa: 'A', x: i * 3.8, y: Math.sin(i) * 5, z: Math.cos(i) * 5, b: 55 + i * 2 }))

const services = { call: async () => ({ n: 20, sequence: 'A'.repeat(20), residues: mk(20) }) }
const ctx = { slots: { registrations: [], register(def, comp) { this.registrations.push({ def, comp }) }, spec: () => ({ kind: 'keyed' }), entriesOfSlot() { return this.registrations.map((r) => ({ options: r.def })) }, subscribeDeclaration: () => () => {} }, agnes: { services }, effect: (f) => { const off = f(); return typeof off === 'function' ? off : undefined } }
mod.apply(ctx)
const reg = ctx.slots.registrations.find((r) => r.def.key === 'predict_structure')
const container = win.document.createElement('div')
win.document.body.appendChild(container)
const report = { savedTo: 'structures/single.pdb', residues: 20, meanPlddt: 78.4, lowSegments: [] }
createRoot(container).render(React.createElement(reg.comp, { owner: { callId: 'l', toolName: 'predict_structure', block: { resultPreview: JSON.stringify(report) } }, services }))
await new Promise((r) => setTimeout(r, 500))

let html = container.innerHTML
check('pLDDT legend mounted with 4 band chips', (html.match(/pv-plddt-el/g) ?? []).length === 4)
check('pLDDT legend carries band labels + note', html.includes('很高 (&gt;90)') && html.includes('极低 (&lt;50)') && html.includes('pLDDT 置信度'))

// default-mode export: the composite must carry the pLDDT band scale row
const pngBtn = [...container.querySelectorAll('button.pv-export')].find((b) => (b.textContent ?? '').trim() === '导出 PNG')
check('3D export button present', !!pngBtn)
if (pngBtn) {
  const before = calls.length
  pngBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 200))
  const texts = calls.slice(before).filter((c) => c[0] === 'fillText').map((c) => c[1])
  const rects = calls.slice(before).filter((c) => c[0] === 'fillRect')
  check('export composite carries pLDDT band labels', ['很高 (>90)', '高 (70–90)', '低 (50–70)', '极低 (<50)'].every((t) => texts.some((x) => String(x) === t)))
  check('export composite carries pLDDT note', texts.some((t) => String(t).includes('pLDDT 置信度')))
  check(`export composite draws 4 band swatches (got ${rects.length} rects)`, rects.length >= 4)
}

// switch to rainbow: legend swaps to the N→C gradient bar, export follows
const select = container.querySelector('.pv-3d-toolbar select')
check('colorMode select present', !!select)
if (select) {
  const setter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value').set
  setter.call(select, 'rainbow')
  select.dispatchEvent(new win.Event('change', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
  html = container.innerHTML
  check('rainbow legend swaps in (N→C bar + note)', html.includes('残基序号 N→C') && (html.match(/pv-pae-legendbar/g) ?? []).length >= 1)
  check('pLDDT legend removed in rainbow mode', !(html.match(/pv-plddt-el/g) ?? []).length)
  if (pngBtn) {
    const before2 = calls.length
    pngBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    const texts2 = calls.slice(before2).filter((c) => c[0] === 'fillText').map((c) => c[1])
    check('rainbow export composite carries N/C + note', texts2.some((t) => String(t) === 'N') && texts2.some((t) => String(t) === 'C') && texts2.some((t) => String(t).includes('残基序号 N→C')))
  }
}
// curve PNG export: composite must carry the same band key row (dark text on
// the white figure background).
const curveChecks = []
const curveBtn = [...container.querySelectorAll('.pv-curve-col button.pv-export')].find((b) => (b.textContent ?? '').trim() === '导出 PNG')
curveChecks.push(['curve export button present', !!curveBtn])
if (curveBtn) {
  const before3 = calls.length
  curveBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 200))
  const texts3 = calls.slice(before3).filter((c) => c[0] === 'fillText').map((c) => c[1])
  curveChecks.push(['curve composite carries band labels', ['很高 (>90)', '极低 (<50)'].every((t) => texts3.some((x) => String(x) === t))])
  curveChecks.push(['curve composite carries pLDDT note', texts3.some((t) => String(t).includes('pLDDT 置信度'))])
}
for (const [name, ok] of curveChecks) { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }

// 3D maximize toggle: button pins the wrap fixed over the viewport; Esc exits.
const maxChecks = []
const wrap = container.querySelector('.pv-3d-wrap')
const maxBtn = container.querySelector('.pv-3d-maxbtn')
maxChecks.push(['maximize button rendered', !!maxBtn && (maxBtn.textContent ?? '').includes('全屏')])
if (maxBtn && wrap) {
  maxBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
  maxChecks.push(['wrap gains maximized class', wrap.className.includes('pv-3d-wrap--max')])
  maxChecks.push(['button flips to exit label', (maxBtn.textContent ?? '').includes('退出全屏')])
  const maxLegend = container.querySelector('.pv-3d-maxlegend')
  // colorMode was left on rainbow by the earlier test — the overlay must
  // mirror the active lens (N→C gradient bar), not the default bands.
  maxChecks.push(['maximized legend overlay mirrors active coloring', !!maxLegend && (maxLegend.querySelectorAll('.pv-pae-legendbar') ?? []).length >= 1])
  // export from the overlay: clicking 导出 PNG must still composite the figure
  const maxExport = [...container.querySelectorAll('.pv-3d-maxbtn')].find((b) => (b.textContent ?? '').trim() === '导出 PNG')
  maxChecks.push(['maximized export button rendered', !!maxExport])
  if (maxExport) {
    const before4 = calls.length
    maxExport.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    const texts4 = calls.slice(before4).filter((c) => c[0] === 'fillText').map((c) => c[1])
    maxChecks.push(['maximized export composites figure', texts4.some((t) => String(t).includes('残基序号 N→C'))])
  }
  win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
  maxChecks.push(['Escape exits maximized mode', !wrap.className.includes('pv-3d-wrap--max')])
  maxChecks.push(['legend overlay removed on exit', !container.querySelector('.pv-3d-maxlegend')])
}
for (const [name, ok] of maxChecks) { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }

// copy-image: the composited figure goes to the clipboard as image/png.
const copyChecks = []
let clipItems = null
globalThis.ClipboardItem = class { constructor(items) { this.items = items; clipItems = items } }
win.HTMLCanvasElement.prototype.toBlob = (cb) => cb(new Blob(['pngbytes'], { type: 'image/png' }))
const writes = []
try { Object.defineProperty(win.navigator, 'clipboard', { value: { write: async (items) => writes.push(items) }, configurable: true }) } catch {}
const copyBtn = [...container.querySelectorAll('button.pv-export')].find((b) => (b.textContent ?? '').trim() === '复制图像')
copyChecks.push(['copy-image button rendered', !!copyBtn])
if (copyBtn) {
  copyBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
  copyChecks.push(['clipboard write receives image/png item', !!clipItems && clipItems['image/png'] instanceof Blob && clipItems['image/png'].type === 'image/png'])
  copyChecks.push(['button confirms copy', (copyBtn.textContent ?? '').includes('已复制')])
}
for (const [name, ok] of copyChecks) { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }

// curve copy-image: same composited figure as the curve export (strip + band
// key row) goes to the clipboard; button lives in the curve toolbar.
const curveCopyChecks = []
const curveCol = container.querySelector('.pv-curve-col')
const curveCopyBtn = [...(curveCol?.querySelectorAll('button.pv-export') ?? [])].find((b) => (b.textContent ?? '').trim() === '复制图像')
curveCopyChecks.push(['curve copy-image button rendered', !!curveCopyBtn])
if (curveCopyBtn) {
  clipItems = null
  writes.length = 0
  curveCopyBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 300))
  curveCopyChecks.push(['curve clipboard write receives image/png', !!clipItems && clipItems['image/png'] instanceof Blob && clipItems['image/png'].type === 'image/png'])
  curveCopyChecks.push(['curve button confirms copy', (curveCopyBtn.textContent ?? '').includes('已复制')])
}
for (const [name, ok] of curveCopyChecks) { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }
process.exit(failed ? 1 : 0)
console.log('LEGEND TESTS DONE')
