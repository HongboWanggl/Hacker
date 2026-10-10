// Mounted render + interaction: search card header clicks sort the hit table
// (asc → desc → back to UniProt relevance order).
import { Window } from '/Users/wanghanbao/agnes-harness/node_modules/.pnpm/happy-dom@20.14.3/node_modules/happy-dom/lib/index.js'
const win = new Window()
globalThis.window = win
globalThis.document = win.document
Object.defineProperty(globalThis, 'navigator', { value: win.navigator, configurable: true })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(16), 16)
globalThis.cancelAnimationFrame = (id) => clearTimeout(id)

const React = (await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')).default
const { createRoot } = await import('/Users/wanghanbao/agnes-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js')

const mod = await import('/tmp/pv-client-test/index.js')
const report = {
  query: 'gene:TP53 AND organism_id:9606',
  hits: [
    { accession: 'P04637', id: 'P53_HUMAN', proteinName: 'Cellular tumor antigen p53', organism: 'Homo sapiens', length: 393 },
    { accession: 'Q9NZJ0', id: 'P63_HUMAN', proteinName: 'Tumor protein 63', organism: 'Homo sapiens', length: 641 },
    { accession: 'P51877', id: 'P73_HUMAN', proteinName: 'Tumor protein 73', organism: 'Homo sapiens', length: 636 },
  ],
}
const ctx = { slots: { registrations: [], register(def, comp) { this.registrations.push({ def, comp }) }, spec: () => ({ kind: 'keyed' }), entriesOfSlot() { return this.registrations.map((r) => ({ options: r.def })) }, subscribeDeclaration: () => () => {} }, agnes: {}, effect: (f) => { const off = f(); return typeof off === 'function' ? off : undefined } }
mod.apply(ctx)
const comp = ctx.slots.registrations.find((r) => r.def.key === 'uniprot_search').comp
const container = win.document.createElement('div')
win.document.body.appendChild(container)
createRoot(container).render(React.createElement(comp, { owner: { callId: 't-s', toolName: 'uniprot_search', block: { resultPreview: JSON.stringify(report) } } }))
await new Promise((r) => setTimeout(r, 300))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
const firstAcc = () => container.querySelector('.pv-search-row .pv-search-acc')?.textContent?.trim()
const headBtn = (label) => [...container.querySelectorAll('.pv-search-head-cell')].find((b) => (b.textContent ?? '').startsWith(label))
let failed = 0
const check = (name, ok) => { console.log(ok ? 'ok ' : 'FAIL', name); if (!ok) failed++ }

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
check('third click returns to relevance order', firstAcc() === 'P04637' && !container.querySelector('.pv-search-head-cell--sorted'))
process.exit(failed ? 1 : 0)
