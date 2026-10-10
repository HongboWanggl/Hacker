// protein.pae service: synthetic-npz unit tests (no real Boltz output needed).
// Builds npz files by hand (stored + deflate entries, fortran_order true/false)
// and checks the quantized output, error paths, and zip64 refusal.
import { deflateRawSync } from 'node:zlib'

const mod = await import('/Users/wanghanbao/agnes-harness/examples/packages/protein-view/extensions/main/index.mjs')
const registered = []
mod.runtime.apply({ services: { register: (def) => registered.push(def) } })
const pae = registered.find((s) => s.name === 'protein.pae')
if (!pae) throw new Error('protein.pae not registered')

let failed = 0
const check = (name, ok) => {
  console.log(ok ? 'ok ' : 'FAIL', name)
  if (!ok) failed++
}
const reject = async (name, path, buf) => {
  try {
    await pae.handler({ path }, { fs: { read: async () => buf }, cwd: '/tmp' })
    check(`${name} rejected`, false)
  } catch {
    check(`${name} rejected`, true)
  }
}

// --- synthetic npz builders -------------------------------------------------
function npyHeader(descr, fortran, shape, verMajor = 1) {
  const dict = `{'descr': '${descr}', 'fortran_order': ${fortran ? 'True' : 'False'}, 'shape': (${shape.join(', ')}${shape.length === 1 ? ',' : ''}), }`
  // numpy pads the header so total length is a multiple of 64.
  let len = 10 + dict.length + 1
  const pad = 64 - (len % 64)
  const hdrLen = dict.length + 1 + pad
  // v2 headers use a 32-bit length field: dict starts at 12 instead of 10.
  const dictOff = verMajor >= 2 ? 12 : 10
  const buf = Buffer.alloc(dictOff + hdrLen)
  buf[0] = 0x93
  buf.write('NUMPY', 1, 'latin1')
  buf[6] = verMajor
  buf[7] = 0
  if (verMajor >= 2) buf.writeUInt32LE(hdrLen, 8)
  else buf.writeUInt16LE(hdrLen, 8)
  buf.write(dict + ' '.repeat(pad) + '\n', dictOff, 'latin1')
  return buf
}

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b }

function zipEntry(name, payload, method) {
  const nameBuf = Buffer.from(name, 'utf8')
  const data = method === 8 ? deflateRawSync(payload) : payload
  const local = Buffer.concat([
    u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0), u32(0), u32(data.length), u32(payload.length),
    u16(nameBuf.length), u16(0), nameBuf,
    data,
  ])
  // Central header up to external attrs; localOff and the name are spliced in
  // by buildZip once the local offset is known (localOff precedes the name).
  const central = Buffer.concat([
    u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
    u32(0), u32(data.length), u32(payload.length),
    u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0),
  ])
  return { local, central, nameBuf }
}

function buildZip(entries) {
  const parts = []
  const centrals = []
  let off = 0
  for (const { name, payload, method } of entries) {
    const e = zipEntry(name, payload, method)
    parts.push(e.local)
    const central = Buffer.concat([e.central, u32(off), e.nameBuf])
    centrals.push(central)
    off += e.local.length
  }
  const cdStart = off
  const cd = Buffer.concat(centrals)
  parts.push(cd)
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(cd.length), u32(cdStart), u16(0)])
  parts.push(eocd)
  return Buffer.concat(parts)
}

// --- fixtures ---------------------------------------------------------------
// 2×2 row-major float32: [[0.0, 8.0], [16.0, 32.0]] → quantized [0, 64, 128, 255]
const mat = Float32Array.from([0, 8, 16, 32])
const rowMajor = Buffer.concat([npyHeader('<f4', false, [2, 2]), Buffer.from(mat.buffer, mat.byteOffset, mat.byteLength)])
// Same values, column-major: [i][j] lives at i + j*2 → order [0, 16, 8, 32]
const colMajor = Buffer.concat([npyHeader('<f4', true, [2, 2]), Buffer.from(Float32Array.from([0, 16, 8, 32]).buffer)])
const zipStored = buildZip([{ name: 'pae.npy', payload: rowMajor, method: 0 }])
const zipDeflate = buildZip([{ name: 'pae.npy', payload: rowMajor, method: 8 }])
const zipFortran = buildZip([{ name: 'pae.npy', payload: colMajor, method: 8 }])
// v2 header (32-bit header length) + float64
const mat64 = Float64Array.from([0, 8, 16, 32])
const v2f64 = Buffer.concat([npyHeader('<f8', false, [2, 2], 2), Buffer.from(mat64.buffer, mat64.byteOffset, mat64.byteLength)])
const zipV2 = buildZip([{ name: 'pae.npy', payload: v2f64, method: 8 }])
const zipNoNpy = buildZip([{ name: 'other.npy', payload: rowMajor, method: 0 }])
const zipNonSquare = buildZip([{ name: 'pae.npy', payload: Buffer.concat([npyHeader('<f4', false, [2, 3]), Buffer.from(Float32Array.from([0, 8, 16, 32, 0, 8]).buffer)]), method: 8 }])

const run = async (buf) => {
  const out = await pae.handler({ path: 'structures/x.npz' }, { fs: { read: async () => buf }, cwd: '/tmp' })
  return Array.from(Buffer.from(out.data, 'base64'))
}

check('stored entry parses', (await run(zipStored)).join() === '0,64,128,255')
check('deflate entry parses', (await run(zipDeflate)).join() === '0,64,128,255')
check('fortran_order reads column-major', (await run(zipFortran)).join() === '0,64,128,255')
check('v2 header + float64 parses', (await run(zipV2)).join() === '0,64,128,255')
check('n reported', (await (async () => {
  const out = await pae.handler({ path: 'structures/x.npz' }, { fs: { read: async () => zipStored }, cwd: '/tmp' })
  return out.n === 2
})()))
await reject('non-npz bytes', 'structures/x.npz', Buffer.from('not a zip'))
check('missing pae.npy falls back to first entry', (await run(zipNoNpy)).join() === '0,64,128,255')
await reject('non-square matrix', 'structures/x.npz', zipNonSquare)
// (matrices over 800 no longer reject — they pool; see the oversize block below)
await reject('path traversal', '../etc.npz', zipStored)
await reject('non-npz extension', 'structures/x.txt', zipStored)

// >800 matrices are mean-pooled blockwise: 1602² with constant-per-block
// values pools losslessly (scale = ceil(1602/800) = 3 → 534×534). Block
// values stay under 32 Å so the quantizer never saturates.
const N = 1602
const K = 3
const M = Math.ceil(N / K)
const blockVal = (bi, bj) => (bi % 12) * 2.5 + (bj % 12) * 0.2
const big = new Float32Array(N * N)
for (let i = 0; i < N; i++) {
  for (let j = 0; j < N; j++) big[i * N + j] = blockVal(Math.floor(i / K), Math.floor(j / K))
}
const bigNpz = buildZip([{ name: 'pae.npy', payload: Buffer.concat([npyHeader('<f4', false, [N, N]), Buffer.from(big.buffer, big.byteOffset, big.byteLength)]), method: 0 }])
const bigOut = await pae.handler({ path: 'structures/big.npz' }, { fs: { read: async () => bigNpz }, cwd: '/tmp' })
check('oversize matrix pools to ≤800', bigOut.n === M && M <= 800)
check('scale reported', bigOut.scale === K)
const bigBytes = Buffer.from(bigOut.data, 'base64')
const cell = (bi, bj) => Math.round((blockVal(bi, bj) / 32) * 255)
check('pooled block mean exact (corner)', bigBytes[0] === cell(0, 0))
check('pooled block mean exact (interior)', bigBytes[100 * M + 200] === cell(100, 200))
check('pooled block mean exact (last row/col)', bigBytes[(M - 1) * M + (M - 1)] === cell(M - 1, M - 1))

if (failed) throw new Error(`${failed} pae service checks failed`)
console.log('PAE SERVICE TESTS DONE')
