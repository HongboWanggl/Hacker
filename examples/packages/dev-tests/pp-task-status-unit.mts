// The wall's honesty rule, pinned. A finished task counts as 已完成 only if it
// produced its deliverable — a structure (single/complex), or the report that
// stands in for one (compare/search). "savedTo is non-empty" is NOT that test:
// every fold task fetches its sequence first, so a run whose prediction failed
// still has sequences/<acc>.fasta on disk. Counting that file is how the
// 2026-10-15 Q02388 run (2944 aa) settled as a green ✓ over an empty 3D slot
// and could never auto-retry (the retry gate used the same wrong test).
//
// Also covers the load-time migration: those rows are already written into the
// user's browser, so a code fix alone would never reach them.
//
// No browser, no network. The localStorage stub has to be installed BEFORE the
// module is loaded and the import done dynamically: orchestrator.ts evaluates
// `let tasks = load()` at import time, so a static import would run it with no
// storage and every seeded row would be silently dropped.
let failures = 0
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(cond ? 'ok ' : 'FAIL', name, extra)
  if (!cond) failures++
}

type Row = Record<string, unknown>
const task = (over: Row): Row => ({
  id: 't1',
  type: 'single',
  title: 'x',
  input: {},
  status: 'done',
  stages: [],
  savedTo: {},
  createdAt: 0,
  updatedAt: 0,
  ...over,
})

const store = new Map<string, string>()
// biome-ignore lint/suspicious/noExplicitAny: minimal localStorage stand-in
;(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
}

const seeded = [
  // The incident, verbatim: a green ✓ that never had a structure.
  task({ id: 'bogus', status: 'done', savedTo: { a: 'sequences/Q02388.fasta' }, lastError: 'ESMFold 413' }),
  // A real success must survive the migration untouched.
  task({ id: 'good', status: 'done', savedTo: { a: 'structures/hba.pdb' } }),
  // A genuine failure must not be re-labelled.
  task({ id: 'failed', status: 'failed', error: 'boom' }),
  // Report-only products (compare) are done and must stay done.
  task({ id: 'clean-done', type: 'compare', status: 'done', resultSavedTo: 'reports/c.json' }),
]
store.set('pp-tasks-v1', JSON.stringify(seeded))

const { getTasks, hasProductArtifact } = await import('../protein-platform/client/src/orchestrator.ts')

// --- the predicate itself ----------------------------------------------------
// biome-ignore lint/suspicious/noExplicitAny: probe reads the record shape the reducer writes
const P = hasProductArtifact as (t: any) => boolean

ok('fetched FASTA only → NOT a product', P(task({ savedTo: { a: 'sequences/Q02388.fasta' } })) === false)
ok('PDB → product', P(task({ savedTo: { a: 'structures/p53_393aa.pdb' } })) === true)
ok(
  'PDB + FASTA → product',
  P(task({ savedTo: { a: 'sequences/P69905.fasta', b: 'structures/hba.pdb' } })) === true,
)
ok(
  'complex inline report (no file) → product',
  P(task({ type: 'complex', resultJson: '{"predictionId":"pred_x"}' })) === true,
)
ok(
  'compare report json → product',
  P(task({ type: 'compare', savedTo: { a: 'reports/compare_P69905.json' } })) === true,
)
ok(
  'compare report via resultSavedTo → product',
  P(task({ type: 'compare', resultSavedTo: 'reports/c.json' })) === true,
)
ok(
  'search report json → product',
  P(task({ type: 'search', savedTo: { a: 'reports/search_hemoglobin.json' } })) === true,
)
ok(
  'search with only a fasta → NOT a product',
  P(task({ type: 'search', savedTo: { a: 'sequences/X.fasta' } })) === false,
)
ok('lowercase .pdb still counts', P(task({ savedTo: { a: 'structures/x.pdb'.toLowerCase() } })) === true)
ok('empty everything → NOT a product', P(task({})) === false)

// --- the migration that repairs rows already sitting in localStorage ---------
const rows = getTasks() as Array<{ id: string; status: string; error?: string }>
const by = (id: string) => rows.find((r) => r.id === id)
ok('bogus 已完成 is demoted to failed', by('bogus')?.status === 'failed', String(by('bogus')?.status))
ok('demotion keeps the real reason', by('bogus')?.error === 'ESMFold 413', String(by('bogus')?.error))
ok('real success stays done', by('good')?.status === 'done')
ok('existing failure untouched', by('failed')?.status === 'failed')
ok('report-only done stays done', by('clean-done')?.status === 'done')
ok('no row lost in migration', rows.length === seeded.length, `${rows.length}/${seeded.length}`)

console.log(failures === 0 ? 'task-status probe: PASS' : `task-status probe: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
