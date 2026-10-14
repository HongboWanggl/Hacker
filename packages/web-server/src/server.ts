import { createHash, randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, isAbsolute, join, posix } from 'node:path'
import { LOGIN_ART } from './login-art.js'
import {
  loadSecret,
  mintSessionToken,
  parseCookies,
  readUsers,
  SESSION_COOKIE,
  SESSION_TTL_S,
  verifyPassword,
  verifySessionToken,
} from './session.js'
import { VENDOR_ENTRY_NAMES } from './vendor-assets.js'

export const DEFAULT_WEB_PORT = 4177
export const WORKSPACE_PICKER_PATH = '/api/workspace-picker'
const HOST = '127.0.0.1'
const FILES = new Set([
  'index.html',
  'admin.html',
  'resources.html',
  'theme.js',
  'theme.js.map',
  'app.js',
  'app.js.map',
  'admin.js',
  'admin.js.map',
  'admin-standalone.js',
  'admin-standalone.js.map',
  'resources.js',
  'resources.js.map',
  'resources-standalone.js',
  'resources-standalone.js.map',
  'style.css',
  'antd.css',
  'tokens.css',
  // 侧栏品牌位与过程行头像共用的客户端 AgnesMark 位图。白名单仍然逐文件放行
  // （不放宽成任意 .png），它由 packages/web/public 随 style.css 一起拷进发行目录。
  'brand-mark.png',
])
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.map': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
}
// Skin assets are a separate namespace from the build artifacts above: their extension allowlist is
// the same one the installer enforces, so an unknown extension is refused here rather than sniffed.
const SKIN_MIME: Record<string, string> = {
  '.css': 'text/css',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.avif': 'image/avif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
}
// Client module assets (`/plugins/*`) are executable code and styles served to the page, so their
// extension allowlist is narrower than the skins one: exactly the module entry, its stylesheet and
// source maps. An unknown extension is refused here rather than sniffed.
const CLIENT_MODULE_MIME: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.map': 'application/json',
}

/** What a skin resolver answers with: a file to read, the bytes, or nothing. */
export type SkinAssetResolution = string | Uint8Array | null

/** What a client module resolver answers with: a file to read, the bytes, or nothing. */
export type ClientModuleAssetResolution = string | Uint8Array | null

/** A reload hint for one immutable client-module snapshot. */
export type PluginRebuiltEvent = Readonly<{ packageId: string; revision: string }>

type WatchedPluginBuild = {
  packageId: string
  revision: string
  mtimeMs: number
  size: number
  digest: string
}

export type WebServerOptions = {
  /** Directory containing the built index.html, app.js and style.css files. */
  root: string
  /** Credential-free loopback WebSocket endpoint advertised to the browser. */
  wsUrl: string
  /** @deprecated Ignored legacy input; local Web access no longer uses a browser token. */
  token?: string
  /** Fixed local HTTP port. The default is kept stable for the daemon origin contract. */
  port?: number
  /** Exact page origin selected by the daemon. Defaults to http://127.0.0.1:<port>. */
  origin?: string
  /**
   * Directory holding `users.json` (scrypt password hashes) and the auto-generated
   * `session-secret` for the form-login gate. The gate itself lives in the public
   * front proxy (Caddy `forward_auth` → `/login/check`); loopback access never goes
   * through it and needs no auth. When unset, the login endpoints still answer but
   * `/login/check` fails closed (500) — deployment without credentials must not
   * accidentally authenticate anyone.
   */
  authHome?: string
  /** Add the source-development reload client and event stream. Disabled for ordinary serve runs. */
  developmentReload?: boolean
  /**
   * Optional fixed admin-surface BFF. It receives matching requests before static routing and
   * returns true only when it wrote the response itself.
   */
  handleAdmin?: (request: IncomingMessage, response: ServerResponse) => Promise<boolean>
  /**
   * Optional same-origin skin asset resolver. Receives the request pathname and answers with either
   * an absolute file path, the bytes themselves, or null. Path authority lives in the resolver (the
   * package manager owns it), so this server never learns where packages are installed; it owns only
   * method, MIME and headers.
   *
   * Bytes exist because the production launcher is not the process that owns the files: it asks the
   * daemon over RPC (design §22). Returning bytes keeps that a single round trip with no temporary
   * file to clean up, and it may be async for the same reason.
   */
  skinAsset?: (pathname: string) => SkinAssetResolution | Promise<SkinAssetResolution>
  /**
   * Optional same-origin client module asset resolver for `/plugins/*` (design WC3). Same contract
   * as `skinAsset`: it receives the request pathname and answers with either an absolute file path,
   * the bytes themselves, or null. Path authority lives in the resolver (the daemon answers only
   * from its immutable snapshots), so this server never learns where packages are installed; it owns
   * only method, the three-MIME allowlist and headers. A miss and a refusal are the same null, which
   * this route turns into the same 404 the skin route uses.
   */
  clientModuleAsset?: (pathname: string) => ClientModuleAssetResolution | Promise<ClientModuleAssetResolution>
  /**
   * Optional launcher-owned subscription to daemon roster rebuilds.  The static server only fans
   * these safe `{ packageId, revision }` hints out over same-origin SSE; it neither watches package
   * directories nor learns package-store paths.  A missing subscription deliberately leaves the
   * endpoint alive but inert (release builds have no development watcher).
   */
  subscribePluginEvents?: (
    listener: (event: PluginRebuiltEvent) => void,
  ) => (() => void) | Promise<() => void>
  /**
   * Poll file-backed plugin build artifacts after they are served.  `mtimeMs` is only a cheap
   * sentinel: a rebuilt event is emitted only after the bytes are hashed and the digest differs.
   * This is intentionally stat polling rather than fs.watch because the resolver may point at a
   * network mount.  The default is 500 ms, a proven cadence for network-backed file systems.
   */
  pluginBuildPollMs?: number
  /** Optional launcher-owned native directory picker. Paths are still validated by workspace.add. */
  workspacePicker?: WorkspacePicker
  /**
   * Optional mounted-Surface reverse proxy (`@agnes/daemon`'s `createMountProxy`). A GET/HEAD consults
   * it just before the static asset whitelist (`fileName`) so a mount like `/demo` is not rejected as
   * an unknown asset, and only there: every branch above it (the workspace picker, `handleAdmin`, the
   * fixed admin API 503s under `/admin`, the `/skins` and `/plugins` resolvers) already returns before
   * this point for any request it handles, so this can never shadow them. Any other method consults it
   * from inside the method gate, only when `Origin` is this server's origin and `Sec-Fetch-Site` is
   * absent or `same-origin`; otherwise that request stays a 405. It answers
   * synchronously with whether it claimed the request (the forwarded response itself is written
   * asynchronously); when it returns false or is not provided, behavior is byte-for-byte the same as
   * before this option existed.
   */
  mountProxy?: (request: IncomingMessage, response: ServerResponse) => boolean
}

export type WorkspacePickerResult =
  | { status: 'selected'; path: string }
  | { status: 'cancelled' }
  | { status: 'unavailable' }

export type WorkspacePicker = {
  available(): Promise<boolean>
  pick(signal: AbortSignal): Promise<WorkspacePickerResult>
}

export type WebServer = {
  url: string
  reloadDevelopmentClients?(): void
  close(): Promise<void>
}

function loopbackOrigin(value: string): URL {
  let origin: URL
  try {
    origin = new URL(value)
  } catch {
    throw new Error('Web origin must be an exact loopback HTTP origin')
  }
  if (
    origin.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new Error('Web origin must be an exact loopback HTTP origin')
  return origin
}

function loopbackWs(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('WebSocket endpoint must be a credential-free loopback URL')
  }
  if (
    !['ws:', 'wss:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('WebSocket endpoint must be a credential-free loopback URL')
  return url
}

function port(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) throw new Error('invalid Web port')
  return value
}

/** WC5：index.html 内联 import map 脚本体（<script type="importmap"> 与 </script> 之间的精确字节）
 *  的 SHA-256，供 CSP script-src 以哈希放行。文件缺失或无 import map 时返回 undefined（fail-closed）。 */
async function importMapScriptHash(root: string): Promise<string | undefined> {
  let html: string
  try {
    html = await readFile(join(root, 'index.html'), 'utf8')
  } catch {
    return undefined
  }
  const match = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)
  if (!match) return undefined
  const body = match?.[1]
  if (!body) return undefined
  return createHash('sha256').update(body, 'utf8').digest('base64')
}

function fileName(requestUrl: string): string {
  let pathname: string
  try {
    pathname = new URL(requestUrl, 'http://127.0.0.1').pathname
  } catch {
    throw new Error('invalid Web request path')
  }
  const file =
    pathname === '/'
      ? 'index.html'
      : pathname === '/admin/plugins' || pathname === '/admin/plugins/'
        ? 'admin.html'
        : pathname === '/admin/resources' || pathname === '/admin/resources/'
          ? 'resources.html'
          : // URL paths use forward slashes on every OS; disk paths are joined only when reading.
            posix.normalize(pathname).replace(/^[/\\]+/, '')
  // esbuild 的 splitting 会为动态 import() 产出带哈希的共享 chunk。它们与入口同为同源静态资源，
  // 所以用固定模式放行，而不是把路径校验放宽成任意文件。
  const isChunk = /^chunk-[A-Za-z0-9_-]+\.(?:js|css)(\.map)?$/.test(file)
  // WC5：/vendor/* 平台共享单例命名空间——入口文件名固定（import map 的映射目标），共享 chunk
  // 走 chunk- 哈希模式；命名空间内不允许任意文件，不放宽成目录列举。
  const vendorEntry = /^vendor\/([a-z0-9-]+)\.js(?:\.map)?$/.exec(file)?.[1]
  const isVendor =
    (vendorEntry !== undefined && VENDOR_ENTRY_NAMES.has(vendorEntry)) ||
    /^vendor\/chunk-[A-Za-z0-9_-]+\.js(\.map)?$/.test(file)
  if (!(FILES.has(file) || isChunk || isVendor) || file.includes('..')) throw new Error('Web asset not found')
  return file
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  })
  response.end(JSON.stringify(body))
}

// --- login gate --------------------------------------------------------------
// The public front (Caddy) checks every gated request here via forward_auth:
// it sends GET /login/check with the browser's Cookie header and the original
// URI in `X-Forwarded-Uri`. A 2xx admits the request (Caddy copies the
// X-Forwarded-User answer header into the proxied request — the identity the
// Surface servers read); a redirect sends the browser to the login page.
// Loopback clients never traverse that gate and are unaffected by all of this.

function safeNextPath(raw: string | null | undefined): string {
  // Open-redirect guard: same-origin absolute paths only (no scheme-relative
  // `//host`, no backslash tricks). Everything else falls back to the platform.
  if (raw?.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') && !raw.includes('\\'))
    return raw
  return '/platform/'
}

const CLEAR_SESSION_COOKIE = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`

function htmlResponse(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  })
  response.end(body)
}

function renderLoginPage(next: string, error?: string): string {
  const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
  // The figures are this platform's own archived predictions (login-art.ts is
  // generated from real archive files), drawn from Cα coordinates and coloured
  // by pLDDT band. Nothing here is a stock image, and the page stays one
  // self-contained document: no request can fail before the user has a session.
  const fig = (a: (typeof LOGIN_ART)[number], hero = false) => `
        <figure class="fig${hero ? ' fig-hero' : ''}">
          <svg viewBox="${a.bounds.join(' ')}" aria-hidden="true">${a.paths
            .map(([d, c, depth]) => `<path class="d${depth}" d="${d}" stroke="${c}"/>`)
            .join('')}</svg>
          <figcaption><b>${attr(a.name)}</b><span>${attr(a.detail)}</span>${
            hero
              ? '<div class="kern">Cα 轨迹，按 pLDDT 着色、按深度分层<br>由本平台自身流程预测产出，非示意图</div>'
              : ''
          }</figcaption>
        </figure>`
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>ProteinLens 蛋白透镜 · 登录</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  :root {
    --fg: #e8eefb; --dim: #93a3bd; --line: rgba(150, 180, 235, .16);
    --accent: #4f7cff; --accent2: #56d4c4;
  }
  body {
    min-height: 100vh; color: var(--fg);
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif;
    background:
      radial-gradient(1100px 620px at 82% -8%, rgba(79, 124, 255, .22), transparent 60%),
      radial-gradient(760px 520px at 6% 108%, rgba(86, 212, 196, .14), transparent 60%),
      linear-gradient(170deg, #080d18 0%, #0c1425 45%, #0a1120 100%);
    background-attachment: fixed;
    display: flex; align-items: center; justify-content: center; padding: 40px 28px;
  }
  .wrap {
    width: 100%; max-width: 1180px; display: grid; gap: 56px;
    grid-template-columns: minmax(0, 1.02fr) minmax(0, .98fr); align-items: center;
  }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 14px; letter-spacing: .12em; }
  .brand b { font-weight: 650; }
  .brand span { color: var(--dim); letter-spacing: .3em; }
  .brand i {
    width: 26px; height: 26px; border-radius: 8px; display: inline-block;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    box-shadow: 0 0 22px rgba(79, 124, 255, .45);
  }
  h1 { font-size: clamp(30px, 3.5vw, 44px); line-height: 1.18; margin: 26px 0 14px; letter-spacing: -.02em; }
  h1 em { font-style: normal; background: linear-gradient(100deg, #7ea2ff, #6fe3d2); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .lead { color: var(--dim); font-size: 15px; line-height: 1.75; max-width: 46ch; }
  .facts { list-style: none; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin: 26px 0 30px; }
  .facts li { border-left: 2px solid var(--line); padding: 2px 0 2px 12px; }
  .facts b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
  .facts span { display: block; color: var(--dim); font-size: 11.5px; line-height: 1.5; margin-top: 4px; }
  form.card {
    border: 1px solid var(--line); border-radius: 16px; padding: 26px 24px 22px;
    background: linear-gradient(180deg, rgba(24, 34, 54, .82), rgba(15, 22, 36, .82));
    backdrop-filter: blur(10px); box-shadow: 0 24px 60px rgba(3, 7, 16, .55);
    max-width: 420px;
  }
  form.card .head { font-size: 13px; color: var(--dim); margin-bottom: 18px; }
  label { display: block; font-size: 12px; color: var(--dim); margin: 0 0 6px; letter-spacing: .04em; }
  input {
    width: 100%; padding: 11px 13px; font-size: 14px; border-radius: 10px; color: inherit;
    border: 1px solid rgba(150, 180, 235, .22); background: rgba(8, 13, 24, .72); outline: none;
    transition: border-color .15s, box-shadow .15s;
  }
  input + label { margin-top: 15px; }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(79, 124, 255, .22); }
  button {
    width: 100%; margin-top: 22px; padding: 12px; font-size: 14.5px; font-weight: 650; letter-spacing: .06em;
    border: 0; border-radius: 10px; color: #05101f; cursor: pointer;
    background: linear-gradient(100deg, #7ea2ff, #6fe3d2);
  }
  button:hover { filter: brightness(1.06); }
  .error { margin-top: 16px; padding: 10px 13px; font-size: 13px; border-radius: 10px; background: rgba(220, 80, 70, .16); border: 1px solid rgba(255, 141, 134, .35); color: #ffb3ad; }
  .foot { color: #6b7c96; font-size: 12px; margin-top: 22px; }
  .art { display: grid; gap: 18px; grid-template-columns: 1fr 1fr; }
  .fig { margin: 0; --w: 1.15; padding: 14px; border-radius: 16px; border: 1px solid var(--line); background: linear-gradient(180deg, rgba(20, 30, 48, .6), rgba(11, 17, 30, .6)); }
  .fig svg { display: block; width: 100%; height: auto; max-height: 132px; filter: drop-shadow(0 0 6px rgba(79, 124, 255, .35)); animation: float 9s ease-in-out infinite; }
  /* Depth cue: strand distance from the viewer drives width and brightness.
     Bands come from the third principal axis of the real Cα coordinates. */
  .fig path { fill: none; stroke-linecap: round; stroke-width: calc(var(--w) * .55); opacity: .34; }
  .fig path.d1 { stroke-width: calc(var(--w) * .75); opacity: .52; }
  .fig path.d2 { stroke-width: var(--w); opacity: .7; }
  .fig path.d3 { stroke-width: calc(var(--w) * 1.3); opacity: .86; }
  .fig path.d4 { stroke-width: calc(var(--w) * 1.65); opacity: 1; }
  .fig figcaption { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; }
  .fig figcaption b { font-size: 12.5px; font-weight: 600; }
  .fig figcaption span { color: var(--dim); font-size: 11.5px; font-variant-numeric: tabular-nums; }
  /* The hero trace is near-square, so a full-width card would letterbox it with
     ~130px of dead air either side. Give the caption its own column instead. */
  .fig-hero { grid-column: 1 / -1; display: grid; grid-template-columns: minmax(0, 1fr) 212px; gap: 20px; align-items: center; padding: 20px 22px; }
  .fig-hero svg { max-height: 300px; }
  .fig-hero figcaption { display: block; margin: 0; }
  .fig-hero figcaption b { display: block; font-size: 15px; }
  .fig-hero figcaption span { display: block; margin-top: 7px; line-height: 1.6; }
  .fig-hero .kern { color: var(--dim); font-size: 11.5px; line-height: 1.6; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line); }
  @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
  /* Offset the phases so the three traces do not bob in lockstep. */
  .fig:nth-child(2) svg { animation-delay: -3s; }
  .fig:nth-child(3) svg { animation-delay: -6s; }
  @media (prefers-reduced-motion: reduce) { .fig svg { animation: none; } }
  @media (max-width: 900px) {
    body { padding: 28px 20px; }
    .wrap { grid-template-columns: 1fr; gap: 34px; }
    h1 { font-size: 30px; }
    form.card { max-width: none; }
    .fig-hero { grid-template-columns: 1fr; gap: 6px; }
    .fig-hero svg { max-height: 220px; }
    .fig-hero .kern { margin-top: 12px; }
  }
  /* Phones: three stat columns squeeze the labels into three-word lines, and
     side-by-side figures wrap their captions — stack both. */
  @media (max-width: 560px) {
    .facts { grid-template-columns: 1fr; gap: 10px; }
    .facts li { display: flex; gap: 12px; align-items: baseline; }
    .facts b { min-width: 72px; }
    .facts span { margin-top: 0; }
    .art { grid-template-columns: 1fr; }
    .fig svg { max-height: 180px; }
  }
</style>
</head>
<body>
  <div class="wrap">
    <section>
      <div class="brand"><i></i><b>ProteinLens</b><span>蛋白透镜</span></div>
      <h1>把蛋白质结构预测，<br>变成<em>一句话</em>的事</h1>
      <p class="lead">
        输入 UniProt ID、原始序列、FASTA，或直接说「人类血红蛋白 α 链」——候选当场列出，选中即预测。
        不需要命令行、Python 或 GPU 环境；每个结果都自带置信度判读：逐残基 pLDDT 着色、置信度曲线、
        复合物 ipTM 与 PAE 热图，并接受 CASP14 公开靶集的外部打分检验。
      </p>
      <ul class="facts">
        <li><b>0.952</b><span>CASP14 T1025<br>Cα-lDDT（实测）</span></li>
        <li><b>±0.6</b><span>自报 pLDDT 与<br>实测 lDDT 校准</span></li>
        <li><b>3 级</b><span>算力路由：自建 GPU<br>→ 托管 API → 本地权重</span></li>
      </ul>
      <form class="card" method="post" action="/login">
        <div class="head">请登录后继续 · 右侧为平台真实预测产出</div>
        <label for="user">账号</label>
        <input id="user" name="user" autocomplete="username" autofocus required>
        <label for="password">密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <input type="hidden" name="next" value="${attr(next)}">
        <button type="submit">登录</button>
        ${error ? `<div class="error">${attr(error)}</div>` : ''}
      </form>
      <div class="foot">Agnes Harness 科研智能体底座 · 南京大学</div>
    </section>
    <section class="art" aria-label="平台真实预测结构">
      ${LOGIN_ART.map((a, i) => fig(a, i === 0)).join('')}
    </section>
  </div>
</body>
</html>`
}

async function handleLoginRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  options: WebServerOptions,
): Promise<void> {
  const pathname = requestUrl.pathname
  if (pathname === '/login/check') {
    if (!options.authHome) {
      response.writeHead(500).end()
      return
    }
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE]
    const user = token ? verifySessionToken(token, loadSecret(options.authHome)) : null
    if (user) {
      response.writeHead(200, { 'X-Forwarded-User': user.sub, 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    const next = safeNextPath(
      (request.headers['x-forwarded-uri'] as string | undefined) ?? requestUrl.searchParams.get('next'),
    )
    response.writeHead(302, { Location: `/login?next=${encodeURIComponent(next)}` }).end()
    return
  }
  if (pathname === '/logout') {
    response.writeHead(302, { Location: '/login', 'Set-Cookie': CLEAR_SESSION_COOKIE }).end()
    return
  }
  // /login — the page itself, or a credential submit.
  if (request.method === 'GET') {
    const next = safeNextPath(requestUrl.searchParams.get('next'))
    htmlResponse(
      response,
      200,
      renderLoginPage(next, requestUrl.searchParams.has('error') ? '账号或密码不对，请重试' : undefined),
    )
    return
  }
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'GET, POST' }).end()
    return
  }
  // Cross-site form posts are refused; same-origin browsers always send both
  // headers, while non-browser clients (probes) send neither and pass.
  if (
    request.headers['sec-fetch-site'] === 'cross-site' ||
    (request.headers.origin !== undefined && request.headers.origin !== requestUrl.origin)
  ) {
    response.writeHead(403).end()
    return
  }
  let body = ''
  for await (const chunk of request) {
    body += chunk
    if (body.length > 32_768) {
      response.writeHead(413).end()
      return
    }
  }
  const form = new URLSearchParams(body)
  const name = (form.get('user') ?? '').trim()
  const next = safeNextPath(form.get('next'))
  if (!options.authHome || !name) {
    htmlResponse(response, 200, renderLoginPage(next, '账号或密码不对，请重试'))
    return
  }
  const stored = readUsers(options.authHome)[name]
  if (!stored || !verifyPassword(form.get('password') ?? '', stored.hash)) {
    htmlResponse(response, 200, renderLoginPage(next, '账号或密码不对，请重试'))
    return
  }
  const token = mintSessionToken({ sub: name, role: stored.role ?? 'guest' }, loadSecret(options.authHome))
  response
    .writeHead(302, {
      Location: next,
      // Plain-http trial: no Secure flag yet — add it when the site moves to TLS.
      'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_S}`,
    })
    .end()
}

function listen(server: Server, requestedPort: number): Promise<{ port: number; host: string }> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error)
    server.once('error', failed)
    server.listen(requestedPort, HOST, () => {
      server.removeListener('error', failed)
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Web listener did not bind'))
        return
      }
      resolve({ port: address.port, host: address.address })
    })
  })
}

/** Start the static Web client. The daemon is intentionally outside this module's lifecycle. */
export async function createWebServer(options: WebServerOptions): Promise<WebServer> {
  if (!isAbsolute(options.root)) throw new Error('Web asset root must be absolute')
  const wsUrl = loopbackWs(options.wsUrl)
  // WC5：对 index.html 内联 import map 的脚本体计算 SHA-256，追加进 CSP script-src（严格哈希，
  // 不放宽策略）。哈希输入是 <script type="importmap"> 与 </script> 之间的精确字节（浏览器语义）。
  // 缺失或解析失败时不追加哈希：内联 import map 会被浏览器拒绝，页面退回无插件模块的现状（fail-closed）。
  const importMapHash = await importMapScriptHash(options.root)
  // Static assets share the base policy. Each HTML response adds its own nonce for Ant Design's
  // CSS-in-JS styles; it is also inserted into that document for ConfigProvider to consume.
  const contentSecurityPolicy = `default-src 'self'; connect-src 'self' ${wsUrl.origin.replace(/^http/, 'ws')}; style-src 'self'; script-src 'self'${importMapHash ? ` 'sha256-${importMapHash}'` : ''}`
  const requestedPort = port(options.port ?? DEFAULT_WEB_PORT)
  const expectedOrigin = loopbackOrigin(options.origin ?? `http://${HOST}:${requestedPort}`)
  if (expectedOrigin.hostname !== HOST && expectedOrigin.hostname !== 'localhost')
    throw new Error('Web origin must use the IPv4 loopback host')
  if (requestedPort !== 0 && Number(expectedOrigin.port || 80) !== requestedPort)
    throw new Error('Web origin port does not match Web listener port')
  if (requestedPort === 0 && !expectedOrigin.port)
    throw new Error('Web origin must include the selected Web listener port')

  let pickerPending = false
  let activePicker: AbortController | undefined
  const pluginEventClients = new Set<ServerResponse>()
  const developmentReloadClients = new Set<ServerResponse>()
  const watchedPluginBuilds = new Map<string, WatchedPluginBuild>()
  let pluginBuildPoller: ReturnType<typeof setInterval> | undefined
  let pluginBuildPollInFlight = false
  const writeSseEvent = (response: ServerResponse, event: string, data: unknown): void => {
    if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const emitPluginRebuilt = (event: PluginRebuiltEvent): void => {
    for (const response of pluginEventClients)
      writeSseEvent(response, 'rebuilt', { type: 'rebuilt', id: event.packageId, rev: event.revision })
  }
  const rememberPluginBuild = async (pathname: string, file: string, bytes: Buffer): Promise<void> => {
    const segments = pathname.split('/').filter(Boolean)
    const revisionIndex = segments.findIndex((segment) =>
      /^(?:sha256-|sha512-)/.test(decodeURIComponent(segment)),
    )
    if (revisionIndex < 2) return
    const revision = decodeURIComponent(segments[revisionIndex] ?? '')
    const packageId = segments.slice(1, revisionIndex).map(decodeURIComponent).join('/')
    try {
      const metadata = await stat(file)
      watchedPluginBuilds.set(file, {
        packageId,
        revision,
        mtimeMs: metadata.mtimeMs,
        size: metadata.size,
        digest: createHash('sha256').update(bytes).digest('hex'),
      })
      if (pluginBuildPoller === undefined) {
        const interval = options.pluginBuildPollMs ?? 500
        if (!Number.isFinite(interval) || interval <= 0) throw new Error('invalid plugin build poll interval')
        pluginBuildPoller = setInterval(() => {
          if (pluginBuildPollInFlight) return
          pluginBuildPollInFlight = true
          void (async () => {
            for (const [path, previous] of watchedPluginBuilds) {
              let metadata: Awaited<ReturnType<typeof stat>>
              try {
                metadata = await stat(path)
              } catch {
                continue
              }
              if (metadata.mtimeMs === previous.mtimeMs && metadata.size === previous.size) continue
              let nextBytes: Buffer
              try {
                nextBytes = await readFile(path)
              } catch {
                continue
              }
              const digest = createHash('sha256').update(nextBytes).digest('hex')
              watchedPluginBuilds.set(path, {
                ...previous,
                mtimeMs: metadata.mtimeMs,
                size: metadata.size,
                digest,
              })
              if (digest !== previous.digest)
                emitPluginRebuilt({ packageId: previous.packageId, revision: previous.revision })
            }
          })().finally(() => {
            pluginBuildPollInFlight = false
          })
        }, interval)
        pluginBuildPoller.unref?.()
      }
    } catch {
      // A resolver may hand back bytes instead of a local file. Such an asset remains supported;
      // only file-backed development artifacts participate in stat polling.
    }
  }
  let stopPluginEvents: (() => void) | undefined
  if (options.subscribePluginEvents) {
    try {
      stopPluginEvents = await options.subscribePluginEvents((event) => {
        emitPluginRebuilt(event)
      })
    } catch {
      // Hot reload is an optional developer affordance. A temporarily unavailable daemon must not
      // prevent the ordinary page (and its normal roster invalidation channel) from starting.
    }
  }
  const server = createServer(async (request, response) => {
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Web listener is not bound')
      const expectedHost = `${HOST}:${address.port}`
      if (request.headers.host !== expectedHost) {
        response.writeHead(403).end()
        return
      }
      const requestUrl = new URL(request.url ?? '/', expectedOrigin)
      if (
        requestUrl.pathname === '/login/check' ||
        requestUrl.pathname === '/login' ||
        requestUrl.pathname === '/logout' ||
        requestUrl.pathname === '/login/'
      ) {
        // Login endpoints sit before every other branch (the 405 method gate, mountProxy
        // and the static whitelist): the gate itself must be reachable unauthenticated.
        // Their non-2xx answers are what Caddy's forward_auth copies back to the browser.
        await handleLoginRoutes(request, response, requestUrl, options)
        return
      }
      if (requestUrl.pathname === WORKSPACE_PICKER_PATH) {
        const site = request.headers['sec-fetch-site']
        if (
          requestUrl.origin !== expectedOrigin.origin ||
          request.url !== WORKSPACE_PICKER_PATH ||
          requestUrl.search !== '' ||
          (site !== undefined && site !== 'same-origin' && site !== 'none') ||
          (request.headers.origin !== undefined && request.headers.origin !== expectedOrigin.origin)
        ) {
          json(response, 403, { error: { code: 'ORIGIN_REJECTED' } })
          return
        }
        if (request.method !== 'GET' && request.method !== 'POST') {
          response.writeHead(405, { Allow: 'GET, POST' }).end()
          return
        }
        if (request.method === 'GET') {
          const available = (await options.workspacePicker?.available().catch(() => false)) ?? false
          json(response, 200, { available })
          return
        }
        if (request.headers.origin !== expectedOrigin.origin) {
          json(response, 403, { error: { code: 'ORIGIN_REJECTED' } })
          return
        }
        if (
          request.headers['transfer-encoding'] !== undefined ||
          Number(request.headers['content-length'] ?? '0') !== 0
        ) {
          json(response, 400, { error: { code: 'INVALID_REQUEST' } })
          return
        }
        if (pickerPending) {
          json(response, 409, { error: { code: 'PICKER_BUSY' } })
          return
        }
        pickerPending = true
        const controller = new AbortController()
        activePicker = controller
        const abort = (): void => controller.abort()
        request.once('aborted', abort)
        response.once('close', abort)
        try {
          const available = (await options.workspacePicker?.available().catch(() => false)) ?? false
          if (controller.signal.aborted && !response.writableEnded) return
          if (!available || !options.workspacePicker) {
            json(response, 503, { status: 'unavailable' })
            return
          }
          const result = await options.workspacePicker
            .pick(controller.signal)
            .catch(() => ({ status: 'unavailable' }) as const)
          if (controller.signal.aborted && !response.writableEnded) return
          if (
            result.status === 'selected' &&
            (result.path.length === 0 ||
              result.path.length > 4096 ||
              result.path.includes('\0') ||
              !isAbsolute(result.path))
          ) {
            json(response, 503, { status: 'unavailable' })
            return
          }
          json(response, result.status === 'unavailable' ? 503 : 200, result)
        } finally {
          request.removeListener('aborted', abort)
          response.removeListener('close', abort)
          if (activePicker === controller) activePicker = undefined
          pickerPending = false
        }
        return
      }
      if (request.url === '/__agnes/dev/reload.js') {
        if (!options.developmentReload) {
          response.writeHead(404).end()
          return
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { Allow: 'GET, HEAD' }).end()
          return
        }
        response.writeHead(200, {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': contentSecurityPolicy,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        })
        response.end(
          request.method === 'HEAD'
            ? undefined
            : `const events = new EventSource('/__agnes/dev/events');\nevents.addEventListener('reload', () => location.reload());\n`,
        )
        return
      }
      if (request.url === '/__agnes/dev/events') {
        if (!options.developmentReload) {
          response.writeHead(404).end()
          return
        }
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' }).end()
          return
        }
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'Content-Security-Policy': contentSecurityPolicy,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        })
        response.flushHeaders()
        developmentReloadClients.add(response)
        const close = (): void => {
          developmentReloadClients.delete(response)
        }
        request.once('aborted', close)
        response.once('close', close)
        return
      }
      if (options.handleAdmin && (await options.handleAdmin(request, response))) return
      if (request.url === '/plugins/events') {
        if (request.method !== 'GET') {
          response.writeHead(405, { Allow: 'GET' }).end()
          return
        }
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'Content-Security-Policy': contentSecurityPolicy,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        })
        response.flushHeaders()
        pluginEventClients.add(response)
        // A graph marker establishes the stream boundary without exposing an installed-package list.
        writeSseEvent(response, 'graph', { type: 'graph' })
        const close = (): void => {
          pluginEventClients.delete(response)
        }
        request.once('aborted', close)
        response.once('close', close)
        return
      }
      const adminPath = request.url ?? ''
      if (adminPath.startsWith('/admin/plugins/api/') || adminPath.startsWith('/admin/resources/api/')) {
        response.writeHead(503, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        response.end(
          JSON.stringify({
            error: {
              code: 'ADMIN_UNAVAILABLE',
              message: adminPath.startsWith('/admin/plugins/api/')
                ? 'The plugin admin service is temporarily unavailable.'
                : 'The resource admin service is temporarily unavailable.',
            },
          }),
        )
        return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        // A mounted Surface's business API writes, so a non-read request may reach mountProxy - but
        // only from this exact page origin: the Host check above cannot stop a cross-site form POST.
        // Every other non-read request keeps the plain 405 it always had.
        const site = request.headers['sec-fetch-site']
        if (
          request.headers.origin === expectedOrigin.origin &&
          (site === undefined || site === 'same-origin') &&
          options.mountProxy?.(request, response)
        )
          return
        response.writeHead(405, { Allow: 'GET, HEAD' }).end()
        return
      }
      const assetPath = new URL(request.url ?? '/', expectedOrigin).pathname
      if (options.skinAsset && assetPath.startsWith('/skins/')) {
        const resolved = await options.skinAsset(assetPath)
        // A file answers for its own extension; bytes have no path of their own, so the request
        // path names the type. Both are the same extension under this route, because the resolver
        // only ever accepts the installer's asset allowlist.
        const named = typeof resolved === 'string' ? resolved : assetPath
        const contentType = resolved === null ? undefined : SKIN_MIME[extname(named).toLowerCase()]
        if (resolved === null || contentType === undefined) {
          response.writeHead(404, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          response.end()
          return
        }
        response.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
          'Content-Security-Policy': contentSecurityPolicy,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        })
        if (request.method === 'HEAD') response.end()
        else response.end(typeof resolved === 'string' ? await readFile(resolved) : resolved)
        return
      }
      // Client module assets (design WC3) follow the skin branch's exact shape: the resolver owns
      // path authority, this route owns method, MIME and headers, and a miss, an unknown suffix and
      // a refusal are the one same 404. It must sit before mountProxy so a mounted Surface can never
      // claim the reserved `/plugins` prefix.
      if (options.clientModuleAsset && assetPath.startsWith('/plugins/')) {
        const resolved = await options.clientModuleAsset(assetPath)
        const named = typeof resolved === 'string' ? resolved : assetPath
        const contentType = resolved === null ? undefined : CLIENT_MODULE_MIME[extname(named).toLowerCase()]
        if (resolved === null || contentType === undefined) {
          response.writeHead(404, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          response.end()
          return
        }
        const bytes = typeof resolved === 'string' ? await readFile(resolved) : Buffer.from(resolved)
        if (typeof resolved === 'string') await rememberPluginBuild(assetPath, resolved, bytes)
        response.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
          'Content-Security-Policy': contentSecurityPolicy,
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
        })
        if (request.method === 'HEAD') response.end()
        else response.end(bytes)
        return
      }
      // A mounted Surface owns its whole prefix (e.g. `/demo`), so it must be consulted before the
      // static asset whitelist below -- otherwise fileName() rejects it as an unknown asset. Placed
      // last among the pre-static branches so it cannot shadow any of them (see the option's doc
      // comment); it also cannot shadow fileName()'s own `/`, `/admin/plugins` or `/admin/resources`
      // special cases, because a live Surface's mount prefix is operator-configured in the trusted
      // deploy directory (never `/`, since the mount schema requires at least one path segment) and
      // the launcher's mount-table filter refuses the reserved `/plugins`, `/admin` and `/skins`
      // prefixes (see packages/cli/launch/surface-mounts.ts).
      if (options.mountProxy?.(request, response)) return
      const file = fileName(request.url ?? '/')
      let body = await readFile(join(options.root, file))
      const documentNonce = file.endsWith('.html') ? randomBytes(16).toString('base64') : undefined
      if (file === 'index.html') {
        const html = body.toString()
        const marker = '__AGNES_WS_URL__'
        const occurrences = html.split(marker).length - 1
        if (occurrences !== 1) throw new Error('Web index is missing its connection marker')
        body = Buffer.from(html.replace(marker, wsUrl.href))
      }
      if (documentNonce) {
        const html = body.toString()
        const marker = '__AGNES_CSP_NONCE__'
        const occurrences = html.split(marker).length - 1
        if (occurrences !== 1) throw new Error('Web document is missing its CSP nonce marker')
        body = Buffer.from(html.replace(marker, documentNonce))
      }
      if (options.developmentReload && file.endsWith('.html')) {
        const html = body.toString()
        const marker = '</body>'
        if (!html.includes(marker)) throw new Error('Web document is missing its body marker')
        body = Buffer.from(
          html.replace(marker, '<script type="module" src="/__agnes/dev/reload.js"></script></body>'),
        )
      }
      // Only the workbench consumes local image/PDF resource URLs; other pages keep the base policy.
      const documentCsp =
        file === 'index.html'
          ? `${contentSecurityPolicy}; img-src 'self' blob:; frame-src 'self' blob:`
          : contentSecurityPolicy
      const responseCsp = documentNonce
        ? documentCsp.replace("style-src 'self'", `style-src 'self' 'nonce-${documentNonce}'`)
        : documentCsp
      const headers = {
        'Content-Type': `${MIME[extname(file)] ?? 'application/octet-stream'}; charset=utf-8`,
        'Cache-Control': 'no-store',
        'Content-Security-Policy': responseCsp,
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      }
      response.writeHead(200, headers)
      if (request.method === 'HEAD') response.end()
      else response.end(body)
    } catch (error) {
      const missing = error instanceof Error && error.message === 'Web asset not found'
      response.writeHead(missing ? 404 : 500).end(missing ? '' : 'web assets unavailable')
    }
  })
  const sockets = new Set<import('node:net').Socket>()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const bound = await listen(server, requestedPort).catch((error: unknown) => {
    server.close()
    throw error
  })
  const actualOrigin = `http://${HOST}:${bound.port}`
  if (expectedOrigin.origin !== actualOrigin) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error(`Web listener origin mismatch: expected ${expectedOrigin.origin}`)
  }
  let closing: Promise<void> | undefined
  return {
    url: actualOrigin,
    reloadDevelopmentClients: () => {
      for (const response of developmentReloadClients) writeSseEvent(response, 'reload', {})
    },
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        activePicker?.abort()
        stopPluginEvents?.()
        if (pluginBuildPoller !== undefined) clearInterval(pluginBuildPoller)
        for (const response of pluginEventClients) response.end()
        pluginEventClients.clear()
        for (const response of developmentReloadClients) response.end()
        developmentReloadClients.clear()
        for (const socket of sockets) socket.destroy()
        server.close((error) => (error ? reject(error) : resolve()))
      })),
  }
}
