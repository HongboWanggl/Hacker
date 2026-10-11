// Client-side test: the batch table mounts ok/failed rows with the mini
// confidence bar (band-colored fill sized by mean pLDDT), row click opens the
// drill-down, and sort select reorders ok rows.
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

let failed = 0
const check = (name, cond) => {
  console.log(cond ? 'ok ' : 'FAIL', name)
  if (!cond) failed++
}

const services = {
  call: async () => ({
    n: 4,
    sequence: 'AAAA',
    residues: [
      { i: 1, chain: 'A', aa: 'A', x: 0, y: 0, z: 0, b: 80 },
      { i: 2, chain: 'A', aa: 'A', x: 4, y: 0, z: 0, b: 82 },
    ],
  }),
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
const reg = ctx.slots.registrations.find((r) => r.def.key === 'batch_predict')
check('batch registration present', !!reg)
const report = {
  summary: { ok: 2, failed: 1, meanPlddt: 78.7 },
  jobs: [
    {
      accession: 'P61626',
      name: 'Lysozyme C',
      status: 'ok',
      residues: 130,
      meanPlddt: 92.4,
      lowSegments: 0,
      savedTo: 'structures/lyz.pdb',
    },
    {
      accession: 'P04637',
      name: 'p53',
      status: 'ok',
      residues: 393,
      meanPlddt: 64.9,
      lowSegments: 3,
      savedTo: 'structures/p53.pdb',
    },
    { accession: 'P00439', name: 'PAH', status: 'error', error: 'ESMFold HTTP 413' },
  ],
}
const container = win.document.createElement('div')
win.document.body.appendChild(container)
createRoot(container).render(
  React.createElement(reg.comp, {
    owner: { callId: 'b', toolName: 'batch_predict', block: { resultPreview: JSON.stringify(report) } },
    services,
  }),
)
await new Promise((r) => setTimeout(r, 500))

const okRows = [...container.querySelectorAll('.pv-batch-row--ok')]
const failRows = [...container.querySelectorAll('.pv-batch-row--failed')]
check('two ok rows + one failed row', okRows.length === 2 && failRows.length === 1)
const bars = okRows.map((r) => r.querySelector('.pv-batch-bar-fill'))
check(
  'ok rows carry mini bars, failed row has none',
  bars.every((b) => b) && failRows.every((r) => !r.querySelector('.pv-batch-bar')),
)
check('bar fill sized by pLDDT (92.4%)', (bars[0]?.getAttribute('style') ?? '').includes('width: 92.4%'))
check('bar fill uses band color (≥90 deep blue)', (bars[0]?.getAttribute('style') ?? '').includes('#0053D6'))
check('low band row uses yellow', (bars[1]?.getAttribute('style') ?? '').includes('#FFDB13'))
check('bar tooltip carries pLDDT', (okRows[0].querySelector('.pv-batch-bar')?.title ?? '').includes('92.4'))

// row click opens the drill-down (async structure load), second click closes
okRows[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 400))
check('row click opens drill-down', !!container.querySelector('.pv-batch-detail'))
// drill-down 3D copy-image: composite goes to the clipboard, button confirms
{
  let clipItems = null
  globalThis.ClipboardItem = class {
    constructor(items) {
      this.items = items
      clipItems = items
    }
  }
  win.HTMLCanvasElement.prototype.toBlob = (cb) => cb(new Blob(['pngbytes'], { type: 'image/png' }))
  const writes2 = []
  try {
    Object.defineProperty(win.navigator, 'clipboard', {
      value: { write: async (items) => writes2.push(items) },
      configurable: true,
    })
  } catch {}
  const detailCopy = [...container.querySelectorAll('.pv-batch-detail .pv-3d-col button.pv-export')].find(
    (b) => (b.textContent ?? '').trim() === '复制图像',
  )
  check('drill-down copy-image button rendered', !!detailCopy)
  if (detailCopy) {
    detailCopy.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 300))
    check(
      'drill-down clipboard write receives image/png',
      !!clipItems && clipItems['image/png'] instanceof Blob && clipItems['image/png'].type === 'image/png',
    )
    check('drill-down button confirms copy', (detailCopy.textContent ?? '').includes('已复制'))
  }
  // drill-down 复制结论: recomputed from the loaded residues (mean, bands,
  // verdict, output file) — same markdown shape as the single-panel conclusion.
  const mdTexts2 = []
  try {
    Object.defineProperty(win.navigator, 'clipboard', {
      value: { writeText: (t) => mdTexts2.push(t) },
      configurable: true,
    })
  } catch {}
  const detailConcl = [...container.querySelectorAll('.pv-batch-detail button')].find(
    (b) => (b.textContent ?? '').trim() === '复制结论',
  )
  check('drill-down copy-conclusion button rendered', !!detailConcl)
  if (detailConcl) {
    detailConcl.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 120))
    const md = mdTexts2.join('\n')
    check(
      'drill-down markdown: title + mean from residues',
      md.startsWith('结构预测结论：P61626') && md.includes('- 平均 pLDDT: 81.0（2 残基）'),
    )
    check('drill-down markdown: band distribution', md.includes('高 (70–90) 2'))
    check(
      'drill-down markdown: verdict + file',
      md.includes('- 解读: 骨架可靠 · 局部待验证') && md.includes('- 结构文件: structures/lyz.pdb'),
    )
    check('drill-down conclusion button confirms', (detailConcl.textContent ?? '').includes('已复制'))
  }
}
okRows[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await new Promise((r) => setTimeout(r, 300))
check('second click closes drill-down', !container.querySelector('.pv-batch-detail'))

// sort by pLDDT: P61626 (92.4) must come before P04637 (64.9)
const sel = container.querySelector('select.pv-select')
const setter = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, 'value').set
setter.call(sel, 'plddt')
sel.dispatchEvent(new win.Event('change', { bubbles: true }))
await new Promise((r) => setTimeout(r, 300))
const accs = [...container.querySelectorAll('.pv-batch-row--ok .pv-batch-acc')].map((e) => e.textContent)
check(`plddt sort reorders rows (got ${accs.join(' > ')})`, accs[0] === 'P61626' && accs[1] === 'P04637')

// 复制结论: a ready-to-paste Markdown block — completion line, cross-job mean,
// and a table row per job with the failure's error text.
const conclBtn2 = [...container.querySelectorAll('button')].find(
  (b) => (b.textContent ?? '').trim() === '复制结论',
)
check('batch copy-conclusion button rendered', !!conclBtn2)
if (conclBtn2) {
  const mdTexts = []
  try {
    Object.defineProperty(win.navigator, 'clipboard', {
      value: { writeText: (t) => mdTexts.push(t) },
      configurable: true,
    })
  } catch {}
  conclBtn2.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 120))
  const md = mdTexts.join('\n')
  check(
    'batch markdown: header + counts',
    md.startsWith('批处理预测结论（batch_predict）') && md.includes('- 完成 2/3 · 失败 1'),
  )
  check('batch markdown: mean pLDDT line', md.includes('- 平均 pLDDT（各蛋白均值）: 78.7'))
  check(
    'batch markdown: ok row carries file',
    md.includes('| P61626 | Lysozyme C | ✅ | 130 | 92.4 | 0 | structures/lyz.pdb |'),
  )
  check(
    'batch markdown: failed row carries error',
    md.includes('| P00439 | PAH | ❌ | — | — | — | ESMFold HTTP 413 |'),
  )
  check('batch button confirms copy', (conclBtn2.textContent ?? '').includes('已复制'))
}
process.exit(failed ? 1 : 0)
console.log('BATCH TABLE TESTS DONE')
