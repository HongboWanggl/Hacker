import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parsePdbStructure } from '../../../protein-view/extensions/main/pdb-parse.mjs'
import { getArchive, listArchive } from './archive.ts'
import { scoreStructures, type ScoreRes } from './lddt.ts'

// The benchmark: CASP14 public targets whose experimental structures shipped in
// the PDB. The manifest + trimmed reference PDBs are curated repo assets (the
// references are single-chain, identity-matched residues only — see the REMARK
// headers), shipped in dist/bench/ so the surface is self-contained. Scoring runs
// on demand: any archived single task whose title is `CASP14-<target>` gets scored
// against its reference on first request and memoized — the runner just needs to
// complete predictions with those titles, no extra plumbing.

export type BenchTarget = {
  id: string
  name: string
  pdb: string
  chain: string
  length: number
  sequence: string
}

type Manifest = { set: string; source?: string; targets: BenchTarget[] }

function benchDir(): string {
  return join(dirnameOfSelf(), 'bench')
}
function dirnameOfSelf(): string {
  // After bundling, server.mjs lives IN dist/ — bench assets sit next to it.
  return new URL('.', import.meta.url).pathname.replace(/\/$/, '')
}

let manifestCache: Manifest | undefined
function manifest(): Manifest {
  if (!manifestCache) {
    manifestCache = JSON.parse(readFileSync(join(benchDir(), 'targets.json'), 'utf8')) as Manifest
  }
  return manifestCache
}

export type BenchRow = BenchTarget & {
  status: 'done' | 'pending'
  taskId?: string
  meanPlddt?: number
  lddt?: number
  rmsd?: number
  identity?: number
  nAligned?: number
}

export type BenchReport = {
  set: string
  rows: BenchRow[]
  calib: Array<{ bin: number; n: number; meanLddt: number }>
  scored: number
  updatedAt: string
}

// Task titles are the runner's contract: `>CASP14-T1064` FASTA headers land as
// archive titles, newest archive wins (resubmissions supersede older attempts).
function findBenchArchive(target: BenchTarget): { taskId: string; meanPlddt?: number } | undefined {
  const prefix = `CASP14-${target.id}`
  const hits = listArchive()
    .filter((m) => (m.type ?? 'single') === 'single' && (m.title ?? '').startsWith(prefix))
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt))
  const meta = hits[0]
  if (!meta) return undefined
  return { taskId: meta.taskId, meanPlddt: meta.meanPlddt }
}

// Scoring is pure math over static inputs (archived PDB + shipped reference) —
// memoize per task so repeat requests don't re-parse everything.
const scoreMemo = new Map<string, ReturnType<typeof scoreStructures>>()

function scoreTask(target: BenchTarget, taskId: string) {
  const cached = scoreMemo.get(taskId)
  if (cached !== undefined) return cached
  let result: ReturnType<typeof scoreStructures> | undefined
  try {
    const { files } = getArchive(taskId)
    const pdb = files['model.pdb']
    if (pdb) {
      const model = parsePdbStructure(pdb.toString('utf8'))
      const ref = parsePdbStructure(readFileSync(join(benchDir(), `${target.id}.pdb`), 'utf8'))
      result = scoreStructures(model.residues as ScoreRes[], ref.residues as ScoreRes[])
    }
  } catch {
    // Missing archive pieces or unparseable PDB → falls through to the
    // workspace scan, not a crash.
  }
  scoreMemo.set(taskId, result)
  return result
}

// The client-side archive write is best-effort (it needs the task's session
// still live in the daemon registry) and drops ~half the runs under a submit
// loop. The workspace on disk is the ground truth of what the pipeline actually
// produced, so bench scoring falls back to scanning tasksRoot for the run's
// artifacts directly — newest report wins (resubmissions supersede).
type WorkspaceArtifacts = { taskId: string; report: Buffer; pdb: Buffer; meanPlddt?: number }
function findWorkspaceArtifacts(target: BenchTarget): WorkspaceArtifacts | undefined {
  const root =
    process.env.PROTEIN_PLATFORM_TASKS_ROOT ??
    join(process.env.AGH_HOME ?? process.env.HOME ?? '/tmp', 'protein-platform', 'tasks')
  const prefix = `CASP14-${target.id}_`
  let best: WorkspaceArtifacts | undefined
  let bestMtime = 0
  let dirs: string[] = []
  try {
    dirs = readdirSync(root)
  } catch {
    return undefined
  }
  for (const dir of dirs) {
    try {
      const repDir = join(root, dir, 'reports')
      const stDir = join(root, dir, 'structures')
      const reportName = readdirSync(repDir).find((f) => f.startsWith(prefix) && f.endsWith('.json'))
      const pdbName = readdirSync(stDir).find((f) => f.startsWith(prefix) && f.endsWith('.pdb'))
      if (!reportName || !pdbName) continue
      const mtime = statSync(join(repDir, reportName)).mtimeMs
      if (mtime <= bestMtime) continue
      const report = readFileSync(join(repDir, reportName))
      best = {
        taskId: dir,
        report,
        pdb: readFileSync(join(stDir, pdbName)),
        meanPlddt: (JSON.parse(report.toString('utf8')) as { meanPlddt?: number }).meanPlddt,
      }
      bestMtime = mtime
    } catch {
      /* unreadable workspace dir → skip */
    }
  }
  return best
}

export function benchReport(): BenchReport {
  const rows: BenchRow[] = []
  const bins = new Map<number, { n: number; sum: number }>()
  let scored = 0
  const pushScored = (target: BenchTarget, s: NonNullable<ReturnType<typeof scoreStructures>>, taskId: string, meanPlddt?: number) => {
    scored++
    for (const r of s.perResidue) {
      const bin = Math.min(9, Math.max(0, Math.floor(r.plddt / 10))) * 10
      const b = bins.get(bin) ?? { n: 0, sum: 0 }
      b.n++
      b.sum += r.lddt
      bins.set(bin, b)
    }
    rows.push({
      ...target,
      status: 'done',
      taskId,
      meanPlddt,
      lddt: Math.round(s.lddt * 1000) / 1000,
      rmsd: Math.round(s.rmsd * 100) / 100,
      identity: Math.round(s.identity * 1000) / 1000,
      nAligned: s.nAligned,
    })
  }
  for (const target of manifest().targets) {
    const hit = findBenchArchive(target)
    if (hit) {
      const s = scoreTask(target, hit.taskId)
      if (s) {
        pushScored(target, s, hit.taskId, hit.meanPlddt)
        continue
      }
    }
    // No (scorable) archive: fall back to the task workspace, whose artifacts
    // are what the pipeline actually produced regardless of archive luck.
    const ws = findWorkspaceArtifacts(target)
    if (ws) {
      let s: ReturnType<typeof scoreStructures>
      try {
        const model = parsePdbStructure(ws.pdb.toString('utf8'))
        const ref = parsePdbStructure(readFileSync(join(benchDir(), `${target.id}.pdb`), 'utf8'))
        s = scoreStructures(model.residues as ScoreRes[], ref.residues as ScoreRes[])
      } catch {
        s = undefined
      }
      if (s) {
        pushScored(target, s, ws.taskId, ws.meanPlddt)
        continue
      }
    }
    rows.push({ ...target, status: 'pending', ...(hit ? { taskId: hit.taskId, meanPlddt: hit.meanPlddt } : {}) })
  }
  return {
    set: manifest().set,
    rows,
    calib: [...bins.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bin, { n, sum }]) => ({ bin, n, meanLddt: Math.round((sum / n) * 1000) / 1000 })),
    scored,
    updatedAt: new Date().toISOString(),
  }
}

/** Target sequences for the bench runner (Playwright submits them as FASTA). */
export function benchTargets(): BenchTarget[] {
  return manifest().targets.map((t) => ({ ...t, name: t.name.replace(/\|/g, '').trim() }))
}
