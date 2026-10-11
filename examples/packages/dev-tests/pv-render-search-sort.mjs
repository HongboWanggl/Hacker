// Mounted render + interaction: search card header clicks sort the hit table
// (asc → desc → back to UniProt relevance order).
import { Window } from '/Users/wanghanbao/agnes-harness/node_modules/.pnpm/happy-dom@20.14.3/node_modules/happy-dom/lib/index.js'

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

const React = (
  await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')
).default
const { createRoot } = await import(
  '/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js'
)

const mod = await import('/tmp/pv-client-test/index.js')
const report = {
  query: 'gene:TP53 AND organism_id:9606',
  hits: [
    {
      accession: 'P04637',
      id: 'P53_HUMAN',
      proteinName: 'Cellular tumor antigen p53',
      organism: 'Homo sapiens',
      length: 393,
    },
    {
      accession: 'Q9NZJ0',
      id: 'P63_HUMAN',
      proteinName: 'Tumor protein 63',
      organism: 'Homo sapiens',
      length: 641,
    },
    {
      accession: 'P51877',
      id: 'P73_HUMAN',
      proteinName: 'Tumor protein 73',
      organism: 'Homo sapiens',
      length: 636,
    },
  ],
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
  agnes: {},
  effect: (f) => {
    const off = f()
    return typeof off === 'function' ? off : undefined
  },
}
mod.apply(ctx)
const comp = ctx.slots.registrations.find((r) => r.def.key === 'uniprot_search').comp
const container = win.document.createElement('div')
win.document.body.appendChild(container)
createRoot(container).render(
  React.createElement(comp, {
    owner: { callId: 't-s', toolName: 'uniprot_search', block: { resultPreview: JSON.stringify(report) } },
  }),
)
await new Promise((r) => setTimeout(r, 300))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
const firstAcc = () => container.querySelector('.pv-search-row .pv-search-acc')?.textContent?.trim()
const headBtn = (label) =>
  [...container.querySelectorAll('.pv-search-head-cell')].find((b) => (b.textContent ?? '').startsWith(label))
let failed = 0
const check = (name, ok) => {
  console.log(ok ? 'ok ' : 'FAIL', name)
  if (!ok) failed++
}

check('relevance order first (P04637)', firstAcc() === 'P04637')
click(headBtn('长度'))
await sleep(200)
check('length asc first (P04637, 393 aa)', firstAcc() === 'P04637')
click(headBtn('长度'))
await sleep(200)
check('length desc first (Q9NZJ0, 641 aa)', firstAcc() === 'Q9NZJ0')
click(headBtn('Accession'))
await sleep(200)
check('accession asc first (P04637)', firstAcc() === 'P04637')
const sortedMarked = container.querySelector('.pv-search-head-cell--sorted')?.textContent ?? ''
check('sorted header highlighted with ▲', sortedMarked.includes('Accession') && sortedMarked.includes('▲'))
click(headBtn('Accession'))
await sleep(200)
check('accession desc first (Q9NZJ0)', firstAcc() === 'Q9NZJ0')
click(headBtn('Accession'))
await sleep(200)
check(
  'third click returns to relevance order',
  firstAcc() === 'P04637' && !container.querySelector('.pv-search-head-cell--sorted'),
)

// batch multi-select: tick rows → hand-off bar → select-all → clear
const checks2 = container.querySelectorAll('.pv-search-row .pv-search-check')
check('per-row checkboxes rendered', checks2.length === 3)
checks2[0].dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(150)
checks2[2].dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(150)
const bar = container.querySelector('.pv-batchbar')
check('batch bar appears with 2 selected', !!bar && (bar.textContent ?? '').includes('已选 2 个'))
const chipBtn = bar?.querySelector('.pv-chip')
chipBtn?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(150)
check('copy button confirms', (chipBtn?.textContent ?? '').includes('已复制'))
const headCheck = container.querySelector('.pv-search-head .pv-search-check')
headCheck.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(150)
check('select-all marks every row', container.querySelectorAll('.pv-search-row--sel').length === 3)
const clearBtn = [...container.querySelectorAll('.pv-batchbar-clear')][0]
clearBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
await sleep(150)
check(
  'clear removes the bar and selection',
  !container.querySelector('.pv-batchbar') && container.querySelectorAll('.pv-search-row--sel').length === 0,
)

// CSV export: right-aligned action in the score row, exports the current sort
const csvBtn = container.querySelector('.pv-search-actions .pv-export')
check('export CSV button in score row', !!csvBtn && (csvBtn.textContent ?? '').trim() === '导出 CSV')
if (csvBtn) {
  const urls = []
  // the component calls the ambient URL/Blob globals, not win.URL
  const origCreate = URL.createObjectURL?.bind(URL)
  URL.createObjectURL = (blob) => {
    const u = origCreate ? origCreate(blob) : `blob:spy-${urls.length}`
    urls.push({ u, blob })
    return u
  }
  csvBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await sleep(150)
  if (origCreate) URL.createObjectURL = origCreate
  const hit = urls[0]
  const text = hit ? await hit.blob.text() : ''
  check(
    'CSV carries header + 3 sorted rows',
    text.startsWith('accession,name,organism,length,uniprot') && text.trim().split('\n').length === 4,
  )
  check('CSV rows carry uniprot links', text.includes('https://www.uniprot.org/uniprotkb/P04637'))
}
process.exit(failed ? 1 : 0)
