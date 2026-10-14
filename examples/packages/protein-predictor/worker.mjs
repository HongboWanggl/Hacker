// Boltz-2 compute worker: wraps runLocalBoltz (boltz.mjs) in a tiny HTTP API so
// a remote host can borrow this machine's GPU. Deployed on a GPU machine behind
// a reverse SSH tunnel (`ssh -R 127.0.0.1:7610:127.0.0.1:7610 <vps>`); the VPS
// side reaches it at http://127.0.0.1:7610 — loopback-only on both ends, so the
// public internet never sees this port.
//   GET  /health  → {ok, busy, bin}
//   POST /predict {proteins:[...], smiles?} → {pdb, paeNpzB64?, conf, aff} or {error}
// Jobs are serialized (one GPU run at a time); BOLTZ_WORKER_TOKEN (0600 file or
// env) turns on a bearer check on /predict when set.

import { accessSync, constants as fsConstants } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { runLocalBoltz } from './boltz.mjs'

const PORT = Number(process.env.BOLTZ_WORKER_PORT ?? 7610)
const BODY_MAX = 64 * 1024
const OUT_MAX = 32 * 1024 * 1024
const BIN = process.env.BOLTZ_LOCAL_BIN ?? join(process.env.HOME ?? '', 'boltz2', 'venv', 'bin', 'boltz')

let token
try {
  if (process.env.BOLTZ_WORKER_TOKEN) token = process.env.BOLTZ_WORKER_TOKEN
  else
    token = (await readFile(join(process.env.HOME ?? '', '.config', 'boltz-worker', 'token'), 'utf8')).trim()
} catch {
  token = undefined
}

const hasBin = await stat(BIN)
  .then(() => true)
  .catch(() => false)
let queue = Promise.resolve()
let busy = false

const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body))
  if (buf.length > OUT_MAX) {
    res.writeHead(413, { 'content-type': 'application/json' })
    res.end('{"error":"result too large"}')
    return
  }
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': buf.length })
  res.end(buf)
}

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    json(res, 200, { ok: true, busy, bin: hasBin })
    return
  }
  if (req.method !== 'POST' || req.url !== '/predict') {
    json(res, 404, { error: 'not found (POST /predict)' })
    return
  }
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: 'bad worker token' })
    return
  }
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > BODY_MAX) {
      json(res, 413, { error: 'body too large' })
      return
    }
  }
  let input
  try {
    input = JSON.parse(body)
  } catch {
    json(res, 400, { error: 'bad json' })
    return
  }
  const proteins = Array.isArray(input.proteins) ? input.proteins.map(String) : []
  const smiles = input.smiles ? String(input.smiles) : undefined
  if (proteins.length === 0 || proteins.some((s) => !/^[ACDEFGHIKLMNPQRSTVWY]{5,}$/.test(s))) {
    json(res, 400, { error: 'proteins must be single-letter aa sequences (>=5 residues)' })
    return
  }
  // Serialize GPU access: runLocalBoltz already caps each run at 20 min.
  busy = true
  queue = queue
    .then(async () => {
      const out = await runLocalBoltz({ proteins, smiles })
      if (out.missing) return json(res, 503, { error: 'boltz CLI not available on worker' })
      if (out.error) return json(res, 502, { error: out.error, ...(out.terminal ? { terminal: true } : {}) })
      const pdb = await readFile(out.modelPdb, 'utf8')
      const paeNpz = out.paeNpz ? (await readFile(out.paeNpz)).toString('base64') : undefined
      json(res, 200, { pdb, ...(paeNpz ? { paeNpzB64: paeNpz } : {}), conf: out.conf, aff: out.aff })
    })
    .catch((e) => json(res, 500, { error: `worker crash: ${String(e?.message ?? e).slice(0, 300)}` }))
    .finally(() => {
      busy = false
    })
})
server.listen(PORT, '127.0.0.1', () => {
  accessSync(BIN, fsConstants.X_OK) // Loud failure at boot if the venv is gone.
  console.log(`[boltz-worker] listening on 127.0.0.1:${PORT} bin=${BIN} token=${token ? 'on' : 'off'}`)
})
// Node ≥18 destroys any in-flight request after 300s by default — a queued
// GPU run routinely outlives that, so the tunnel client sees the response die
// at exactly 5min while the fold keeps running server-side (observed on the
// 408aa T1024 retry, 2026-10-14). Long jobs are already bounded by the client's
// 22min fetch window and runLocalBoltz's own 20min cap, so lift the HTTP limit.
server.requestTimeout = 0
