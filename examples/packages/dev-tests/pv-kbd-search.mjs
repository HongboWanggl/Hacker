// Client-side: search-table keyboard navigation. Rows are native buttons
// (Tab/Enter already work); ↑/↓ rove focus between rows, Home/End jump,
// Space ticks the batch checkbox instead of copying. Offline via happy-dom.
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

const React = (await import('../../../node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')).default
const { createRoot } = await import(
  '../../../node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/client.js'
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
    owner: { callId: 't-k', toolName: 'uniprot_search', block: { resultPreview: JSON.stringify(report) } },
  }),
)
await new Promise((r) => setTimeout(r, 500))

let failed = 0
const check = (ok, msg) => {
  console.log(ok ? 'ok ' : 'FAIL', msg)
  if (!ok) failed++
}
const rows = () => [...container.querySelectorAll('.pv-search-row')]
const focusedIdx = () => rows().indexOf(win.document.activeElement)
const key = (el, k) =>
  el.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
const selRows = () => rows().filter((r) => r.className.includes('pv-search-row--sel')).length
const batchCount = () => container.querySelector('.pv-batchbar-count')?.textContent ?? ''

check(rows().length === 3, `table mounted with 3 rows (got ${rows().length})`)
check(
  rows().every((r) => r.getAttribute('aria-pressed') === 'false'),
  'rows expose aria-pressed=false initially',
)

// Roving focus with real .focus() + arrow keys
rows()[0].focus()
check(focusedIdx() === 0, 'first row focusable')
key(win.document.activeElement, 'ArrowDown')
check(focusedIdx() === 1, 'ArrowDown moves row focus to #2')
key(win.document.activeElement, 'ArrowDown')
check(focusedIdx() === 2, 'ArrowDown again → #3')
key(win.document.activeElement, 'ArrowDown')
check(focusedIdx() === 2, 'ArrowDown at last row clamps')
key(win.document.activeElement, 'ArrowUp')
check(focusedIdx() === 1, 'ArrowUp moves back to #2')
key(win.document.activeElement, 'End')
check(focusedIdx() === 2, 'End jumps to last row')
key(win.document.activeElement, 'Home')
check(focusedIdx() === 0, 'Home jumps to first row')

// Space ticks the batch checkbox (instead of copy); Enter still copies.
key(win.document.activeElement, ' ')
await new Promise((r) => setTimeout(r, 100))
check(selRows() === 1, 'Space ticks the focused row')
check(batchCount().includes('1'), `batch bar shows 已选 1 (${batchCount()})`)
check(rows()[0].getAttribute('aria-pressed') === 'true', 'ticked row exposes aria-pressed=true')
key(win.document.activeElement, ' ')
await new Promise((r) => setTimeout(r, 100))
check(selRows() === 0, 'Space again unticks the row')
rows()[1].focus()
win.document.activeElement.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true }))
await new Promise((r) => setTimeout(r, 100))
check(
  (rows()[1].querySelector('.pv-search-acc')?.textContent ?? '').includes('✓'),
  'click still copies the accession (✓ feedback)',
)

// Sort headers are native <button>s: real browsers give Tab/Enter/Space for
// free (happy-dom doesn't synthesize Enter→click, so pin the structure).
check(
  [...container.querySelectorAll('.pv-search-head-cell')].every(
    (c) => c.tagName === 'BUTTON' && c.getAttribute('type') === 'button',
  ),
  'sort headers are native buttons (keyboard-sortable by construction)',
)

console.log(failed ? 'KBD SEARCH FAIL' : 'KBD SEARCH OK')
process.exit(failed ? 1 : 0)
