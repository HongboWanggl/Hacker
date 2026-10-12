import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getArchive, listArchive, putArchive } from './archive.ts'

// AGH Surface: serves the platform SPA + archive API under the mount prefix
// (default /platform). The daemon allocates the loopback PORT and passes the
// mount via AGNES_SURFACE_MOUNT (packages/daemon/src/surfaces/local-runtime.ts).

const MOUNT = (process.env.AGNES_SURFACE_MOUNT ?? '/platform').replace(/\/$/, '')
// After bundling, server.mjs lives IN dist/ — static root is its own directory.
const DIST = dirname(fileURLToPath(import.meta.url))
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
}

function send(res: ServerResponse, status: number, body: string | Buffer, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req: IncomingMessage, cap = 4 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > cap) throw new Error('payload too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

// The daemon WS endpoint moves on every daemon start (ephemeral port); read it
// fresh from the discovery file so the SPA always gets a reachable URL.
function daemonWsUrl(): string | null {
  const home = process.env.AGH_HOME
  if (!home) return null
  const path = join(home, 'data', 'daemon', 'discovery.json')
  if (!existsSync(path)) return null
  try {
    const disc = JSON.parse(readFileSync(path, 'utf8')) as { web?: { url?: string } }
    return disc.web?.url ?? null
  } catch {
    return null
  }
}

function configJson(): string {
  // The daemon passes AGH_HOME through to local node surfaces; HOME is the fallback.
  const home = process.env.AGH_HOME ?? process.env.HOME ?? '/tmp'
  return JSON.stringify({
    wsUrl: process.env.PROTEIN_PLATFORM_WS_URL ?? daemonWsUrl(),
    profile: process.env.AGNES_PROFILE ?? 'local-dev',
    rowId: 'web:@aghes/protein-view',
    bffPath: '/api/client-modules/service',
    tasksRoot: process.env.PROTEIN_PLATFORM_TASKS_ROOT ?? join(home, 'protein-platform', 'tasks'),
  })
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  let pathname = decodeURIComponent(url.pathname)
  // The daemon's mount proxy strips the prefix before forwarding (mount-proxy.ts
  // `path: suffix`), and the health probe hits healthPath unprefixed. Accept both
  // with and without the mount prefix so standalone testing works too.
  if (pathname === MOUNT || pathname.startsWith(`${MOUNT}/`)) {
    pathname = pathname.slice(MOUNT.length) || '/'
  }
  if (pathname === '/') pathname = '/index.html'
  const rel = pathname.slice(1)

  if (rel === 'health') {
    send(res, 200, 'ok', 'text/plain')
    return
  }
  if (rel === 'config.json') {
    send(res, 200, configJson())
    return
  }
  if (rel === 'api/task' && req.method === 'POST') {
    // Per-task workspace dir: the SPA composes <tasksRoot>/<taskId>, the server
    // creates it (browsers cannot mkdir), then the SPA registers it as a workspace.
    try {
      const { taskId } = JSON.parse((await readBody(req)).toString('utf8')) as { taskId?: string }
      if (!taskId || !/^[A-Za-z0-9_-]{1,80}$/.test(taskId)) throw new Error('bad taskId')
      const { mkdirSync } = await import('node:fs')
      const root = process.env.PROTEIN_PLATFORM_TASKS_ROOT
        ?? join(process.env.AGH_HOME ?? process.env.HOME ?? '/tmp', 'protein-platform', 'tasks')
      mkdirSync(join(root, taskId), { recursive: true })
      send(res, 200, JSON.stringify({ ok: true }))
    } catch (e) {
      send(res, 400, JSON.stringify({ error: (e as Error).message }))
    }
    return
  }
  if (rel.startsWith('api/archive')) {
    try {
      if (req.method === 'POST' && rel === 'api/archive') {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        send(res, 200, JSON.stringify(putArchive(body)))
        return
      }
      if (req.method === 'GET' && rel === 'api/archive') {
        send(res, 200, JSON.stringify(listArchive()))
        return
      }
      const taskId = rel.split('/')[2] ?? ''
      if (req.method === 'GET' && taskId) {
        const { meta, files } = getArchive(taskId)
        send(res, 200, JSON.stringify({
          ...meta,
          files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.toString('base64')])),
        }))
        return
      }
      send(res, 405, JSON.stringify({ error: 'method not allowed' }))
    } catch (e) {
      send(res, (e as Error).message === 'not found' ? 404 : 400, JSON.stringify({ error: (e as Error).message }))
    }
    return
  }

  // Static files with SPA fallback. Guard against traversal before touching fs.
  const clean = normalize(rel).replace(/^(\.\.[/\\])+/, '')
  let file = join(DIST, clean)
  if (!file.startsWith(DIST)) {
    send(res, 403, 'forbidden', 'text/plain')
    return
  }
  try {
    const s = await stat(file)
    if (s.isDirectory()) file = join(file, 'index.html')
  } catch {
    file = join(DIST, 'index.html') // SPA fallback (#/task/:id etc. are hash routes, but be safe)
  }
  try {
    const data = await readFile(file)
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=300',
    })
    res.end(data)
  } catch {
    send(res, 404, 'not found', 'text/plain')
  }
}

const port = Number(process.env.PORT ?? 0)
createServer((req, res) => {
  handle(req, res).catch((e) => send(res, 500, JSON.stringify({ error: String(e) })))
}).listen(port, '127.0.0.1', () => {
  console.log(`[protein-platform] serving ${MOUNT} on 127.0.0.1:${port}`)
})
