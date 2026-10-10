// Backend runtime for @aghes/protein-view.
// Exposes one query service, `protein.structure`, that reads a predicted PDB from the
// session workspace and returns the CA-atom backbone with per-residue pLDDT so the
// browser panel can render without any file access of its own.

import { inflateRawSync } from 'node:zlib'

const AA3_TO_1 = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G',
  HIS: 'H', ILE: 'I', LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S',
  THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V', ASX: 'B', GLX: 'Z', SEC: 'U', PYL: 'O',
  UNK: 'X',
}

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
        const residues = []
        const seen = new Set()
        const chainOrder = new Map()
        for (const line of pdb.split('\n')) {
          if (!line.startsWith('ATOM')) continue
          const atomName = line.slice(12, 16).trim()
          if (atomName !== 'CA') continue
          const resNum = Number(line.slice(22, 26).trim())
          const chain = line.slice(21, 22).trim() || 'A'
          // Identity is chain + residue number: multi-chain complexes (Boltz-2
          // output) restart numbering at 1 per chain, and deduping on resNum
          // alone would drop every colliding chain.
          const key = `${chain}:${resNum}`
          if (!Number.isInteger(resNum) || seen.has(key)) continue
          const x = Number(line.slice(30, 38).trim())
          const y = Number(line.slice(38, 46).trim())
          const z = Number(line.slice(46, 54).trim())
          const b = Number(line.slice(60, 66).trim())
          if (![x, y, z].every(Number.isFinite)) continue
          seen.add(key)
          if (!chainOrder.has(chain)) chainOrder.set(chain, chainOrder.size)
          const aa = AA3_TO_1[line.slice(17, 20).trim().toUpperCase()] ?? 'X'
          residues.push({
            i: resNum,
            chain,
            aa,
            x: Math.round(x * 100) / 100,
            y: Math.round(y * 100) / 100,
            z: Math.round(z * 100) / 100,
            b: Number.isFinite(b) ? Math.round(b * 10) / 10 : 0,
          })
        }
        if (residues.length === 0) throw new Error(`no CA atoms found in ${rel}`)
        // Group by chain in file order, then by residue number — never interleave
        // chains (a flat i-sort would zigzag between two chains both numbered 1..n).
        residues.sort((a, b) => chainOrder.get(a.chain) - chainOrder.get(b.chain) || a.i - b.i)
        // ESMFold writes pLDDT on a 0-1 scale; AlphaFold-family files use 0-100. Normalize so the
        // browser panel can treat `b` as pLDDT/100 uniformly.
        const maxB = residues.reduce((m, r) => Math.max(m, r.b), 0)
        if (maxB > 0 && maxB <= 1.5) for (const r of residues) r.b = Math.round(r.b * 1000) / 10
        return {
          n: residues.length,
          sequence: residues.map((r) => r.aa).join(''),
          residues,
        }
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
        const { shape, fortran, float } = parseNpy(npy)
        const n = shape[0]
        if (!Number.isInteger(n) || n < 2 || n !== shape[1]) throw new Error(`pae matrix is not square (shape ${shape.join('x')})`)
        if (n > 800) throw new Error(`pae matrix too large (${n} residues; cap 800)`)
        const out = Buffer.alloc(n * n)
        for (let i = 0; i < n; i++) {
          for (let j = 0; j < n; j++) {
            // fortran_order stores column-major: [i][j] lives at i + j*n.
            const v = float[fortran ? i + j * n : i * n + j]
            out[i * n + j] = Math.max(0, Math.min(255, Math.round((Number.isFinite(v) ? v : 32) / 32 * 255)))
          }
        }
        return { n, data: out.toString('base64') }
      },
    })
  },
}

// ---------------------------------------------------------------------------
// Minimal .npz (zip) / .npy readers — just enough for what numpy's savez
// writes. Central-directory based, so data-descriptor (streamed) entries with
// zeroed local sizes parse correctly; stored and deflate both handled.

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
  const ab = bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + start + count * (descr === '<f8' ? 8 : 4))
  switch (descr) {
    case '<f4':
      return { shape, fortran, float: new Float32Array(ab) }
    case '<f8':
      return { shape, fortran, float: new Float64Array(ab) }
    default:
      throw new Error(`unsupported npy dtype ${descr} (expected float32/64)`)
  }
}
