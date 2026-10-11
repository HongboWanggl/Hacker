// Headless render smoke test for the protein-view panel using happy-dom.
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

const React = (await import('../../../node_modules/.pnpm/react@18.3.1/node_modules/react/index.js')).default
const { renderToString } = await import(
  '../../../node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/server.js'
)

const report = {
  residues: 393,
  meanPlddt: 80.3,
  bands: {
    veryHigh_gt90: { count: 152, pct: 38.7 },
    confident_70_90: { count: 128, pct: 32.6 },
    low_50_70: { count: 108, pct: 27.5 },
    veryLow_lt50: { count: 5, pct: 1.3 },
  },
  lowConfidenceSegments: [
    { residues: '27-60', length: 34, meanPlddt: 56.1 },
    { residues: '88-95', length: 8, meanPlddt: 59.8 },
  ],
  verdict: 'backbone mostly reliable; inspect low-confidence segments',
  savedTo: 'structures/p53_human_P04637_393aa.pdb',
}
const services = {
  call: async (name, _input) => {
    if (name !== 'protein.structure') throw new Error(`unexpected ${name}`)
    const residues = []
    for (let i = 1; i <= 12; i++)
      residues.push({
        i,
        aa: 'MEEPQSDPSVEP'[i - 1],
        x: i * 3.8 - 20,
        y: Math.sin(i) * 5,
        z: Math.cos(i) * 5,
        b: 40 + i * 4,
      })
    return { n: 12, sequence: residues.map((r) => r.aa).join(''), residues }
  },
}

// Import the client entry
const mod = await import('/tmp/pv-client-test/index.js')
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
}
mod.apply(ctx)
const regs = ctx.slots.registrations
console.log('registered slots:', regs.map((r) => `${r.def.name}:${r.def.key}`).join(', '))
if (regs.length !== 7) throw new Error('expected 7 registrations')

// Render each slot component with the mock owner
for (const { def, comp } of regs) {
  const el = React.createElement(comp, {
    owner: { callId: 't1-x', toolName: def.key, block: { resultPreview: JSON.stringify(report) } },
  })
  const html = renderToString(el)
  if (!html.includes('pv-root')) throw new Error(`${def.key}: missing pv-root`)
  if (!html.includes('80.3')) throw new Error(`${def.key}: missing mean score`)
  if (!html.includes('27-60')) throw new Error(`${def.key}: missing segment chip`)
  if (def.key === 'predict_structure' && !/很高 \((&gt;|>)90\) · 39%/.test(html))
    throw new Error('legend missing band percentages')
  console.log(`render ${def.key}: OK (${html.length} bytes)`)
}
// Fallback path: unparsable preview
const el2 = React.createElement(regs[0].comp, {
  owner: { block: { resultPreview: 'plain text error output' } },
})
const html2 = renderToString(el2)
if (!html2.includes('pv-fallback')) throw new Error('fallback missing')
console.log('render fallback: OK')
console.log('ALL RENDER TESTS PASS')
process.exit(0)
