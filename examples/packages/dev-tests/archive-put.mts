// putArchive workspace-pull unit probe: the client now posts ONE small body of
// workspace-relative paths and the server reads <tasksRoot>/<taskId>/ itself.
// Covers: single assembly (report/pdb/PAE/meanPlddt/verdict/thumb), the
// traversal guard, batch jobPdbs mirroring, and the over-budget pdb-drop
// degradation (report survives, pdb-* dropped largest-first).
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'pp-archive-put-'))
process.env.PROTEIN_PLATFORM_ARCHIVE_DIR = join(root, 'archive')
process.env.PROTEIN_PLATFORM_TASKS_ROOT = join(root, 'tasks')

const { getArchive, putArchive, archiveFileFor, archivePae } = await import(
  '../protein-platform/server/src/archive.ts'
)

let passed = 0
function ok(name: string, fn: () => void) {
  fn()
  passed++
  console.log(`  ok - ${name}`)
}

// --- fixtures ---------------------------------------------------------------

// Minimal stored-method zip (npz-parse does not check CRCs) holding one npy.
function npz(n: number): Buffer {
  const dict = `{'descr': '<f4', 'fortran_order': False, 'shape': (${n}, ${n}), }`
  const padded = dict.length % 2 ? `${dict} ` : dict
  const npy = Buffer.concat([
    Buffer.from([0x93], 0, 1),
    Buffer.from('NUMPY', 'latin1'),
    Buffer.from([1, 0]),
    Buffer.from([padded.length & 0xff, padded.length >> 8]),
    Buffer.from(padded, 'latin1'),
    Buffer.from(Float32Array.from({ length: n * n }, (_, i) => 1 + (i % 7)).buffer),
  ])
  const name = Buffer.from('pae.npy')
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0, 8) // method 0 = stored
  local.writeUInt32LE(npy.length, 18)
  local.writeUInt32LE(npy.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4) // version needed
  central.writeUInt16LE(0, 10) // method stored
  central.writeUInt32LE(npy.length, 20) // compressed size
  central.writeUInt32LE(npy.length, 24) // uncompressed size
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(0, 42) // local header offset
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(46 + name.length, 12) // central dir size
  eocd.writeUInt32LE(30 + name.length + npy.length, 16) // central dir offset
  return Buffer.concat([local, name, npy, central, name, eocd])
}

function pdb(bFactors: number[]): string {
  return bFactors
    .map((b, i) => {
      const x = (i * 3.8).toFixed(3)
      const res = (i + 1).toString().padStart(4)
      const serial = (i + 1).toString().padStart(5)
      const bs = b.toFixed(2).padStart(6)
      return `ATOM  ${serial}  CA  ALA A${res}      ${x}   0.000   0.000  1.00${bs}           C`
    })
    .join('\n')
}

// Task workspace: reports/<id>.json, structures/<id>.pdb, structures/pae.npz
function fixtureTask(taskId: string, report: Record<string, unknown>, bs: number[]) {
  const root = process.env.PROTEIN_PLATFORM_TASKS_ROOT
  if (!root) throw new Error('PROTEIN_PLATFORM_TASKS_ROOT is required')
  const dir = join(root, taskId)
  mkdirSync(join(dir, 'reports'), { recursive: true })
  mkdirSync(join(dir, 'structures'), { recursive: true })
  writeFileSync(join(dir, 'reports', 'CASP14-T1025_268aa.confidence.json'), JSON.stringify(report))
  writeFileSync(join(dir, 'structures', 'CASP14-T1025_268aa.pdb'), pdb(bs))
  writeFileSync(join(dir, 'structures', 'pae.npz'), npz(4))
  return dir
}

const SINGLE_REPORT = {
  file: 'structures/CASP14-T1025_268aa.pdb',
  residues: 4,
  paePath: 'structures/pae.npz',
}

console.log('putArchive workspace pulls')

// --- 1. single: report + pdb + pae + backfills ------------------------------
{
  fixtureTask('task-single', SINGLE_REPORT, [93.4, 93.4, 93.4, 93.4])
  const meta = putArchive({
    taskId: 'task-single',
    type: 'single',
    title: 'CASP14-T1025 268aa',
    workspace: {
      report: 'reports/CASP14-T1025_268aa.confidence.json',
      pdb: 'structures/CASP14-T1025_268aa.pdb',
      pae: 'structures/pae.npz',
    },
  })
  ok('meta carries reportPath/pdbPath', () => {
    assert.equal(meta.reportPath, 'report.json')
    assert.equal(meta.pdbPath, 'model.pdb')
  })
  ok('meanPlddt backfilled from B-factors', () => {
    assert.equal(meta.meanPlddt, 93.4)
  })
  ok('verdict backfilled (≥90 → 高置信结构)', () => {
    assert.equal(meta.verdict, '高置信结构')
  })
  ok('report.json stored verbatim', () => {
    const { files } = getArchive('task-single')
    assert.deepEqual(JSON.parse(files['report.json'].toString('utf8')), SINGLE_REPORT)
  })
  ok('model.pdb pulled from workspace', () => {
    const { files } = getArchive('task-single')
    assert.ok(files['model.pdb'].toString('utf8').includes('93.40'))
  })
  ok('pae.json quantized ({n, data})', () => {
    const pae = archivePae('task-single') as { n: number; data: string }
    assert.equal(pae.n, 4)
    assert.equal(Buffer.from(pae.data, 'base64').length, 16)
  })
  ok('wall thumb precomputed at write time', () => {
    assert.ok(meta.thumb && meta.thumb.d.length > 0 && meta.thumb.c.length > 0)
  })
}

// --- 2. traversal guard ------------------------------------------------------
{
  fixtureTask('task-trav', SINGLE_REPORT, [80, 80, 80, 80])
  const meta = putArchive({
    taskId: 'task-trav',
    type: 'single',
    workspace: { report: '../../etc/passwd', pdb: '../../tasks/other/structures/x.pdb' },
  })
  ok('traversal paths resolve to nothing (no report/pdb)', () => {
    assert.equal(meta.reportPath, undefined)
    assert.equal(meta.pdbPath, undefined)
    const { files } = getArchive('task-trav')
    assert.equal(files['report.json'], undefined)
    assert.equal(files['model.pdb'], undefined)
  })
}

// --- 3. batch: inline report b64 + workspace jobPdbs --------------------------
{
  fixtureTask('task-batch', { jobs: [] }, [90, 90, 90, 90])
  const dir = join(
    process.env.PROTEIN_PLATFORM_TASKS_ROOT ??
      (() => {
        throw new Error('PROTEIN_PLATFORM_TASKS_ROOT is required')
      })(),
    'task-batch',
  )
  writeFileSync(join(dir, 'structures', 'P12345.pdb'), pdb([88, 88, 88, 88]))
  writeFileSync(join(dir, 'structures', 'Q9Y6K9.pdb'), pdb([75, 75, 75, 75]))
  const resultJson = JSON.stringify({
    summary: { total: 2, ok: 2, meanPlddt: 81.5 },
    jobs: [
      { status: 'ok', savedTo: 'structures/P12345.pdb' },
      { status: 'ok', savedTo: 'structures/Q9Y6K9.pdb' },
      { status: 'error', savedTo: 'structures/FAILED.pdb' },
    ],
  })
  const meta = putArchive({
    taskId: 'task-batch',
    type: 'batch',
    verdict: '2/2 目标成功',
    meanPlddt: 81.5,
    files: { 'report.json': Buffer.from(resultJson).toString('base64') },
    workspace: {
      jobPdbs: {
        'P12345.pdb': 'structures/P12345.pdb',
        'Q9Y6K9.pdb': 'structures/Q9Y6K9.pdb',
      },
    },
  })
  ok('batch: meta.jobPdbs mirrored from workspace map', () => {
    assert.deepEqual(meta.jobPdbs, ['P12345.pdb', 'Q9Y6K9.pdb'])
  })
  ok('batch: pdb-<basename> stored, failed job excluded', () => {
    const { files } = getArchive('task-batch')
    assert.ok(files['pdb-P12345.pdb'])
    assert.ok(files['pdb-Q9Y6K9.pdb'])
    assert.equal(files['pdb-FAILED.pdb'], undefined)
  })
  ok('archiveFileFor resolves by workspace path basename', () => {
    const f = archiveFileFor('task-batch', 'structures/Q9Y6K9.pdb')
    assert.equal(f.name, 'Q9Y6K9.pdb')
    assert.equal(Buffer.from(f.b64, 'base64').toString('utf8').includes('75.00'), true)
  })
}

// --- 4. over budget: pdb-* dropped, report survives ---------------------------
{
  fixtureTask('task-big', SINGLE_REPORT, [70, 70, 70, 70])
  const big = Buffer.alloc(3 * 1024 * 1024, 65).toString('base64') // 3 MiB fake PDB
  const meta = putArchive({
    taskId: 'task-big',
    type: 'single',
    workspace: { report: 'reports/CASP14-T1025_268aa.confidence.json' },
    files: {
      'pdb-big.pdb': big,
      'report.json': Buffer.from(JSON.stringify(SINGLE_REPORT)).toString('base64'),
    },
  })
  ok('over budget: pdb-* dropped, archive still lands (report.json present)', () => {
    assert.equal(meta.reportPath, 'report.json')
    const { files } = getArchive('task-big')
    assert.ok(files['report.json'])
    assert.equal(files['pdb-big.pdb'], undefined)
  })
}

// --- 5. absolute savedTo normalization ----------------------------------------
{
  const dir = fixtureTask('task-abs', SINGLE_REPORT, [85, 85, 85, 85])
  const meta = putArchive({
    taskId: 'task-abs',
    type: 'single',
    workspace: {
      report: join(dir, 'reports', 'CASP14-T1025_268aa.confidence.json'),
      pdb: join(dir, 'structures', 'CASP14-T1025_268aa.pdb'),
    },
  })
  ok('absolute savedTo inside the task workspace still resolves', () => {
    assert.equal(meta.reportPath, 'report.json')
    assert.equal(meta.pdbPath, 'model.pdb')
  })
}

rmSync(root, { recursive: true, force: true })
console.log(`\n${passed} assertions passed`)
