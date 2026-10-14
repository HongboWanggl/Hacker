// Minimal localStorage so the browser-side task store can be loaded in node.
//
// Imported for its side effect BEFORE orchestrator.ts anywhere a probe needs to
// drive the real ledger reducer: the store reads localStorage at module load, and
// ESM evaluates a module's dependencies in import-statement order, so a stub
// assigned in the importing file's body would run too late.
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
