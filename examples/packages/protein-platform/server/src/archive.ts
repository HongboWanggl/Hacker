import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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
}

function archiveRoot(): string {
  return process.env.PROTEIN_PLATFORM_ARCHIVE_DIR
    ?? join(process.env.HOME ?? '/tmp', 'protein-platform', 'archive')
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

export function listArchive(): ArchiveEntry[] {
  const root = archiveRoot()
  if (!existsSync(root)) return []
  const out: ArchiveEntry[] = []
  for (const id of readdirSync(root)) {
    const metaPath = join(root, id, 'meta.json')
    if (!existsSync(metaPath)) continue
    try {
      out.push(JSON.parse(readFileSync(metaPath, 'utf8')) as ArchiveEntry)
    } catch {
      /* skip corrupt entries */
    }
  }
  return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1))
}

export function deleteArchive(taskId: string): void {
  rmSync(taskDir(taskId), { recursive: true, force: true })
}
