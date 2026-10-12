import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePdbStructure } from '../../../protein-view/extensions/main/pdb-parse.mjs'

// Completed-task archive: report JSON + PDB (+ PAE) persisted at task completion
// so history renders even after a daemon restart (the BFF requires a live session
// in the daemon registry). One directory per task, size-capped.

const MAX_TASK_BYTES = 2 * 1024 * 1024

export type ArchiveEntry = {
  taskId: string
  sessionId?: string
  type?: string
  title?: string
  savedAt: string
  /** Headline numbers copied out of the confidence report at write time, so the
   *  home report wall can render score cards without opening the archive. */
  meanPlddt?: number
  verdict?: string
  /** Workspace-relative artifact paths (report / pdb) for the result page. */
  reportPath?: string
  pdbPath?: string
  /** Batch archives: basenames of the per-target PDBs stored as pdb-<basename>,
   *  so wall cards can render mini structure thumbnails per job. */
  jobPdbs?: string[]
  /** Single/complex archives with a UniProt source: lets the archived result page
   *  offer the AlphaFold-DB compare flow without the original live task. */
  accession?: string
}

function archiveRoot(): string {
  return (
    process.env.PROTEIN_PLATFORM_ARCHIVE_DIR ??
    join(process.env.HOME ?? '/tmp', 'protein-platform', 'archive')
  )
}

function taskDir(taskId: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId)) throw new Error('bad taskId')
  return join(archiveRoot(), taskId)
}

export function putArchive(body: {
  taskId: string
  sessionId?: string
  type?: string
  title?: string
  meanPlddt?: number
  verdict?: string
  reportPath?: string
  pdbPath?: string
  jobPdbs?: string[]
  accession?: string
  files: Record<string, string> // name -> base64
}): ArchiveEntry {
  const dir = taskDir(body.taskId)
  const total = Object.values(body.files ?? {}).reduce((n, b64) => n + Buffer.byteLength(b64, 'base64'), 0)
  if (total > MAX_TASK_BYTES) throw new Error(`archive payload too large (${total} bytes)`)
  mkdirSync(dir, { recursive: true })
  const meta: ArchiveEntry = {
    taskId: body.taskId,
    sessionId: body.sessionId,
    type: body.type,
    title: body.title,
    savedAt: new Date().toISOString(),
    ...(typeof body.meanPlddt === 'number' ? { meanPlddt: body.meanPlddt } : {}),
    ...(body.verdict ? { verdict: body.verdict } : {}),
    ...(body.reportPath ? { reportPath: body.reportPath } : {}),
    ...(body.pdbPath ? { pdbPath: body.pdbPath } : {}),
    ...(Array.isArray(body.jobPdbs) && body.jobPdbs.length > 0 ? { jobPdbs: body.jobPdbs.slice(0, 8) } : {}),
    ...(body.accession ? { accession: body.accession } : {}),
  }
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta))
  for (const [name, b64] of Object.entries(body.files ?? {})) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) continue
    writeFileSync(join(dir, name), Buffer.from(b64, 'base64'))
  }
  return meta
}

export function getArchive(taskId: string): { meta: ArchiveEntry; files: Record<string, Buffer> } {
  const dir = taskDir(taskId)
  if (!existsSync(join(dir, 'meta.json'))) throw new Error('not found')
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as ArchiveEntry
  const files: Record<string, Buffer> = {}
  for (const name of readdirSync(dir)) {
    if (name === 'meta.json') continue
    files[name] = readFileSync(join(dir, name))
  }
  return { meta, files }
}

/** Archived confidence report, served verbatim so the client renders it exactly as
 *  a live protein.report fetch would. */
export function archiveReport(taskId: string): unknown {
  const { files } = getArchive(taskId)
  const report = files['report.json']
  if (!report) throw new Error('no report in archive')
  return JSON.parse(report.toString('utf8'))
}

/** protein.structure-shaped output parsed client-side-server from the archived PDB —
 *  the same shape a live BFF protein.structure call returns, so the pv components
 *  cannot tell an archived result from a live one. */
export function archiveStructure(taskId: string): unknown {
  const { files } = getArchive(taskId)
  const pdb = files['model.pdb']
  if (!pdb) throw new Error('no PDB in archive')
  return parsePdbStructure(pdb.toString('utf8'))
}

// Batch archives store each successful target as `pdb-<basename>` (the batch
// report carries no single model.pdb). `path` is the workspace-relative path
// the client asks for; only the basename matters for lookup.
function pickPdb(files: Record<string, Buffer>, path?: string): Buffer {
  const base = (path ?? '').split('/').pop() ?? ''
  const pdb = (base && files[`pdb-${base}`]) || files['model.pdb']
  if (!pdb) throw new Error('no PDB in archive')
  return pdb
}

/** protein.structure for a batch target (or the single model.pdb fallback). */
export function archiveStructureFor(taskId: string, path?: string): unknown {
  const { files } = getArchive(taskId)
  return parsePdbStructure(pickPdb(files, path).toString('utf8'))
}

/** protein.file-shaped ({b64, name}) read from any archived PDB — powers the
 *  PDB download button on archived batch rows. */
export function archiveFileFor(taskId: string, path?: string): { b64: string; name: string } {
  const { files } = getArchive(taskId)
  const base = (path ?? '').split('/').pop() ?? ''
  const key = base && files[`pdb-${base}`] ? `pdb-${base}` : 'model.pdb'
  return { b64: pickPdb(files, path).toString('base64'), name: key.replace(/^pdb-/, '') }
}

/** Archived PAE heatmap (quantized matrix persisted at archive time), same shape
 *  the live protein.pae service returns. */
export function archivePae(taskId: string): unknown {
  const { files } = getArchive(taskId)
  const pae = files['pae.json']
  if (!pae) throw new Error('no PAE in archive')
  return JSON.parse(pae.toString('utf8'))
}

export function listArchive(): ArchiveEntry[] {
  const root = archiveRoot()
  if (!existsSync(root)) return []
  const out: ArchiveEntry[] = []
  for (const id of readdirSync(root)) {
    const metaPath = join(root, id, 'meta.json')
    if (!existsSync(metaPath)) continue
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as ArchiveEntry
      let dirty = false
      // Batch archives from before jobPdbs existed: derive the per-target PDB
      // basenames from the directory so wall cards can render mini thumbnails.
      if (meta.type === 'batch' && !meta.jobPdbs) {
        const jobs = readdirSync(join(root, id))
          .filter((n) => n.startsWith('pdb-'))
          .map((n) => n.slice(4))
        if (jobs.length > 0) {
          meta.jobPdbs = jobs.slice(0, 8)
          dirty = true
        }
      }
      // Archives written before mean-pLDDT backfill carry no score (complex
      // reports never had one). Derive it from the stored model's B-factors —
      // same number the client would have computed at archive time.
      if (meta.meanPlddt === undefined) {
        try {
          const pdb = readFileSync(join(root, id, 'model.pdb'), 'utf8')
          const residues = parsePdbStructure(pdb).residues as Array<{ b?: number }>
          const bs = residues.map((r) => r.b).filter((v) => Number.isFinite(v))
          if (bs.length > 0) {
            meta.meanPlddt = Math.round((bs.reduce((s, v) => s + v, 0) / bs.length) * 10) / 10
            if (!meta.verdict) {
              for (const [floor, label] of [
                [90, '高置信结构'],
                [70, '骨架可靠 · 局部待验证'],
                [50, '置信偏低 · 谨慎解读'],
              ] as Array<[number, string]>)
                if (meta.meanPlddt >= floor) {
                  meta.verdict = label
                  break
                }
              meta.verdict ??= '低置信 · 大概率含无序区'
            }
            dirty = true
          }
        } catch {
          /* no model.pdb or unparsable — card stays scoreless */
        }
      }
      // Persist enrichment once — list runs on every wall load; re-parsing
      // every scoreless PDB each time is wasted work (write-back, not cache).
      if (dirty) {
        try {
          writeFileSync(metaPath, JSON.stringify(meta))
        } catch {
          /* read-only fs — enrichment stays per-request */
        }
      }
      out.push(meta)
    } catch {
      /* skip corrupt entries */
    }
  }
  return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
}

export function deleteArchive(taskId: string): void {
  rmSync(taskDir(taskId), { recursive: true, force: true })
}
