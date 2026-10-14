// NPZ/NPY reading + PAE mean-pooling, shared between the protein-view runtime
// (protein.pae service) and the protein-platform surface server (archive.ts
// server-side PAE quantization) so the quantized-matrix shape cannot drift.
import { inflateRawSync } from 'node:zlib'

// Mean-pool an n×n float matrix into k×k blocks (n = pooled count). Used to
// bring PAE matrices over the 800-cell result budget down to display size;
// each output cell is the arithmetic mean of its block (NaN/Inf → 32 Å, the
// same worst-case clamp the quantizer applies).
export function meanPool(float, fortran, n, k) {
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

export function readNpzEntries(buf) {
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

export function readNpzEntry(buf, name) {
  return readNpzEntries(buf)[name]
}

export function parseNpy(bytes) {
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
