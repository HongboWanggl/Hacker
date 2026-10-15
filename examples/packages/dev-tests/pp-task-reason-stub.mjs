// localStorage + a pre-seeded wall for pp-task-reason-unit.mts.
//
// Imported for its side effect BEFORE orchestrator.ts: the task store runs
// `load()` at module-evaluation time, so the seed has to be in localStorage
// before that module is evaluated — which in ESM means a separate dependency
// listed first, not a statement in the importing file's body. That also means
// the store cannot be re-seeded mid-run, so every case gets its own row up
// front and no case can contaminate another.
const store = new Map()
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
  key: (i) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  },
}

/** Every id a case may drive, as a fresh running single-type task. */
export const CASE_IDS = [
  'long-chain',
  'long-chain-then-transient',
  // The routing-signal cases: an ESMFold length refusal the agent handled by
  // switching to predict_complex, whose own failure is the real reason.
  'routed-then-oom',
  'fold-then-analysis',
  'fetch-only',
  'blocked-turn',
  'stall-abort',
  'unknown-reason',
  'genuine-done',
  'no-error-at-all',
  'fasta-only',
]

store.set(
  'pp-tasks-v1',
  JSON.stringify(
    CASE_IDS.map((id) => ({
      id,
      type: 'single',
      title: '单体结构预测',
      input: { accession: 'Q02388', name: 'Q02388' },
      status: 'running',
      stages: [],
      savedTo: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
  ),
)
