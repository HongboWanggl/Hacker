// Backend runtime for @aghes/protein-view.
// Exposes one query service, `protein.structure`, that reads a predicted PDB from the
// session workspace and returns the CA-atom backbone with per-residue pLDDT so the
// browser panel can render without any file access of its own.

import { inflateRawSync } from 'node:zlib'
// The PDB parser proper lives in ./pdb-parse.mjs (shared with the protein-platform
// surface server's archive rendering so the residue/ligand shapes cannot drift).
import { parsePdbStructure } from './pdb-parse.mjs'

// Workspace-relative PDB paths only — except that an absolute path pointing inside the
// calling session's workspace is normalized, so results produced by earlier plugin
// versions (which emitted absolute savedTo) keep rendering. fs.read is already
// workspace-confined by the host; this keeps the contract tight and errors useful.
const SAFE_PATH = /^(?!\.)[\w][\w./-]{0,500}\.pdb$/
const ABSOLUTE_SAFE = /^\/[\w./-]{1,1000}\.pdb$/
// Report JSONs (uniprot_search writes reports/search_<slug>.json) — same shape rules
// as PDB paths, different extension.
const SAFE_JSON = /^(?!\.)[\w][\w./-]{0,500}\.json$/
const ABSOLUTE_SAFE_JSON = /^\/[\w./-]{1,1000}\.json$/

export const runtime = {
  apply(ctx) {
    ctx.services.register({
      name: 'protein.structure',
      kind: 'query',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path of a predicted PDB file' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          n: { type: 'number' },
          sequence: { type: 'string' },
          residues: { type: 'array' },
          // Ligand HETATM parse (flat arrays — the protocol rejects nested
          // object schemas): atoms [{el,x,y,z}], bonds [[a,b]] index pairs.
          ligandAtoms: { type: 'array' },
          ligandBonds: { type: 'array' },
        },
        required: ['n', 'sequence', 'residues'],
        additionalProperties: false,
      },
      timeoutMs: 5000,
      maxResultBytes: 1048576,
      async handler({ path }, svc) {
        let rel = typeof path === 'string' ? path : ''
        if (ABSOLUTE_SAFE.test(rel)) {
          const cwd = svc.cwd.endsWith('/') ? svc.cwd : `${svc.cwd}/`
          if (rel.startsWith(cwd)) rel = rel.slice(cwd.length)
        }
        if (!SAFE_PATH.test(rel)) {
          throw new Error(`invalid PDB path: ${JSON.stringify(String(path).slice(0, 80))}`)
        }
        const bytes = await svc.fs.read(rel)
        const pdb = Buffer.from(bytes).toString('utf8')
        return parsePdbStructure(pdb)
      },
    })
    // Full tool-report reader: the transcript clips a tool result's preview at 4096
    // chars, so large reports (search hit tables, batch results) arrive truncated and
    // the panel cannot parse them. Tools save the full JSON into the workspace and put
    // `savedTo` first in the result; the panel fetches the whole report through here.
    ctx.services.register({
      name: 'protein.report',
      kind: 'query',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path of a saved report JSON' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      outputSchema: { type: 'object', additionalProperties: true },
      // Protocol caps maxResultBytes at 1 MiB (E_SERVICE_DEF beyond that); search
      // reports are tens of KB, so the cap is plenty.
      timeoutMs: 5000,
      maxResultBytes: 1048576,
      async handler({ path }, svc) {
        let rel = typeof path === 'string' ? path : ''
        if (ABSOLUTE_SAFE_JSON.test(rel)) {
          const cwd = svc.cwd.endsWith('/') ? svc.cwd : `${svc.cwd}/`
          if (rel.startsWith(cwd)) rel = rel.slice(cwd.length)
        }
        if (!SAFE_JSON.test(rel)) {
          throw new Error(`invalid report path: ${JSON.stringify(String(path).slice(0, 80))}`)
        }
        const bytes = await svc.fs.read(rel)
        return JSON.parse(Buffer.from(bytes).toString('utf8'))
      },
    })
    // PAE (predicted aligned error) matrix reader for Boltz-2 local runs: parses
    // the `pae_{input}_model_0.npz` the tool saves next to the model PDB and
    // returns a quantized N×N byte matrix (0-255 ↦ 0-32 Å) for the panel heatmap.
    ctx.services.register({
      name: 'protein.pae',
      kind: 'query',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path of a saved PAE .npz file' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          n: { type: 'number' },
          data: { type: 'string' },
          scale: { type: 'number' },
        },
        required: ['n', 'data'],
        additionalProperties: false,
      },
      // Protocol caps maxResultBytes at 1 MiB: 800² bytes → ~853 KB base64.
      timeoutMs: 5000,
      maxResultBytes: 1048576,
      async handler({ path }, svc) {
        let rel = typeof path === 'string' ? path : ''
        if (ABSOLUTE_SAFE_JSON.test(rel)) {
          const cwd = svc.cwd.endsWith('/') ? svc.cwd : `${svc.cwd}/`
          if (rel.startsWith(cwd)) rel = rel.slice(cwd.length)
        }
        if (!/^(?!\.)[\w][\w./-]{0,500}\.npz$/.test(rel)) {
          throw new Error(`invalid npz path: ${JSON.stringify(String(path).slice(0, 80))}`)
        }
        const buf = Buffer.from(await svc.fs.read(rel))
        const npy = readNpzEntry(buf, 'pae.npy') ?? Object.values(readNpzEntries(buf))[0]
        if (!npy) throw new Error(`no pae array in ${rel}`)
        const parsed = parseNpy(npy)
        let { shape, fortran, float } = parsed
        let n = shape[0]
        if (!Number.isInteger(n) || n < 2 || n !== shape[1])
          throw new Error(`pae matrix is not square (shape ${shape.join('x')})`)
        // The 1 MiB result budget fits 800×800 bytes; longer chains are
        // mean-pooled blockwise so the heatmap stays available (display only —
        // scale tells the panel each cell covers `scale` residues).
        let scale = 1
        if (n > 800) {
          scale = Math.ceil(n / 800)
          const pooled = meanPool(float, fortran, n, scale)
          n = pooled.n
          float = pooled.float
          fortran = false
        }
        const out = Buffer.alloc(n * n)
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            // fortran_order stores column-major: [i][j] lives at i + j*n.
            const v = float[fortran ? i + j * n : i * n + j]
            out[i * n + j] = Math.max(
              0,
              Math.min(255, Math.round(((Number.isFinite(v) ? v : 32) / 32) * 255)),
            )
          }
        }
        return scale > 1 ? { n, data: out.toString('base64'), scale } : { n, data: out.toString('base64') }
      },
    })
    // Raw-file download relay: panels get a「下载 PDB」button so a browser-only
    // user (remote daemon deployment) can take the actual structure file out of
    // the workspace — CA-coordinate data the structure service returns is not
    // enough to reconstruct it. Read-only, extension-allowlisted, size-capped.
    ctx.services.register({
      name: 'protein.file',
      kind: 'query',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path of a predicted PDB file' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          b64: { type: 'string' },
          bytes: { type: 'number' },
        },
        required: ['name', 'b64'],
        additionalProperties: false,
      },
      timeoutMs: 5000,
      // 1 MiB protocol cap; a base64 PDB up to ~700 KB raw fits. Larger
      // structures are rejected with a clear message rather than truncated.
      maxResultBytes: 1048576,
      async handler({ path }, svc) {
        let rel = typeof path === 'string' ? path : ''
        if (ABSOLUTE_SAFE.test(rel)) {
          const cwd = svc.cwd.endsWith('/') ? svc.cwd : `${svc.cwd}/`
          if (rel.startsWith(cwd)) rel = rel.slice(cwd.length)
        }
        if (!SAFE_PATH.test(rel)) {
          throw new Error(`invalid PDB path: ${JSON.stringify(String(path).slice(0, 80))}`)
        }
        const bytes = Buffer.from(await svc.fs.read(rel))
        if (bytes.length > 700000) {
          throw new Error(
            `PDB too large to download via panel (${bytes.length} bytes); copy it from the workspace instead`,
          )
        }
        return {
          name: rel.split('/').pop() ?? 'structure.pdb',
          b64: bytes.toString('base64'),
          bytes: bytes.length,
        }
      },
    })
  },
}

// ---------------------------------------------------------------------------
// Minimal .npz (zip) / .npy readers — just enough for what numpy's savez
// writes. Central-directory based, so data-descriptor (streamed) entries with
// zeroed local sizes parse correctly; stored and deflate both handled.

// Mean-pool an n×n float matrix into k×k blocks (n = pooled count). Used to
// bring PAE matrices over the 800-cell result budget down to display size;
// each output cell is the arithmetic mean of its block (NaN/Inf → 32 Å, the
// same worst-case clamp the quantizer applies).
function meanPool(float, fortran, n, k) {
  const m = Math.ceil(n / k)
  const out = new Float32Array(m * m)
  const at = (i, j) => float[fortran ? i + j * n : i * n + j]
  for (let bi = 0; bi < m; bi++) {
    for (let bj = 0; bj < m; bj++) {
      let sum = 0
      let cnt = 0
      for (let i = bi * k; i < Math.min((bi + 1) * k, n); i++) {
        for (let j = bj * k; j < Math.min((bj + 1) * k, n); j++) {
          const v = at(i, j)
          sum += Number.isFinite(v) ? v : 32
          cnt++
        }
      }
      out[bi * m + bj] = cnt ? sum / cnt : 32
    }
  }
  return { n: m, float: out }
}

function readNpzEntries(buf) {
  // Locate the end-of-central-directory record (signature 0x06054b50), scanning
  // back over a possible zip64 locator and comment.
  let eocd = -1
  for (let off = buf.length - 22; off >= Math.max(0, buf.length - 22 - 65536); off--) {
    if (buf.readUInt32LE(off) === 0x06054b50) {
      eocd = off
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (npz)')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  const entries = {}
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const commentLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8')
    // PAE matrices are ≤ 800² bytes — far below the zip64 threshold. A 0xffffffff
    // size here would mean zip64 extra fields, which this reader does not parse.
    if (csize === 0xffffffff) throw new Error(`zip64 entry not supported (${name})`)
    // Jump from the central entry to the local header to find the data start.
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`corrupt zip entry ${name}`)
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.slice(dataStart, dataStart + csize)
    entries[name] = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    off += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

function readNpzEntry(buf, name) {
  return readNpzEntries(buf)[name]
}

function parseNpy(bytes) {
  if (bytes.length < 10 || bytes[0] !== 0x93 || bytes.toString('latin1', 1, 6) !== 'NUMPY') {
    throw new Error('not an npy payload')
  }
  const verMajor = bytes[6]
  const hdrLen = verMajor >= 2 ? bytes.readUInt32LE(8) : bytes.readUInt16LE(8)
  const header = bytes.toString('latin1', 10, 10 + hdrLen)
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1] ?? '<f4'
  const fortran = /'fortran_order':\s*True/.test(header)
  const shapeStr = /'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? ''
  const shape = shapeStr
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((x) => Number.isInteger(x) && x > 0)
  // v2 headers use a 32-bit length field, so the data starts 2 bytes later.
  const start = (verMajor >= 2 ? 12 : 10) + hdrLen
  const count = shape.reduce((a, b) => a * b, 1)
  // Buffer may be a pooled view: slice the underlying bytes it actually covers.
  const ab = bytes.buffer.slice(
    bytes.byteOffset + start,
    bytes.byteOffset + start + count * (descr === '<f8' ? 8 : 4),
  )
  switch (descr) {
    case '<f4':
      return { shape, fortran, float: new Float32Array(ab) }
    case '<f8':
      return { shape, fortran, float: new Float64Array(ab) }
    default:
      throw new Error(`unsupported npy dtype ${descr} (expected float32/64)`)
  }
}
