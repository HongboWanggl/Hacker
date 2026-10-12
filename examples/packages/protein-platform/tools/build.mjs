import { cpSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from '../../../../node_modules/.pnpm/esbuild@0.28.2/node_modules/esbuild/lib/main.js'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = join(here, '..')
const dist = join(pkg, 'dist')
mkdirSync(dist, { recursive: true })

// pnpm's strict layout hides react from example packages; point esbuild at the
// workspace store (same 18.3.1 singletons the AGH web bundle uses).
const nodePaths = [
  join(here, '../../../..', 'node_modules/.pnpm/react@18.3.1/node_modules'),
  join(here, '../../../..', 'node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules'),
]

// Browser bundle: platform SPA + the protein-view toolview components, react
// bundled in (the surface serves its own index.html — no import map, no host).
await build({
  entryPoints: [join(pkg, 'client/src/main.tsx')],
  nodePaths,
  bundle: true,
  format: 'esm',
  splitting: false,
  outdir: dist,
  entryNames: 'app',
  platform: 'browser',
  target: 'es2023',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  sourcemap: false,
  logLevel: 'info',
})

// Node bundle: the surface HTTP server. The surface schema mandates ./dist/*.mjs.
await build({
  entryPoints: [join(pkg, 'server/src/main.ts')],
  nodePaths,
  bundle: true,
  format: 'esm',
  outdir: dist,
  entryNames: 'server',
  platform: 'node',
  target: 'node22',
  external: ['node:*'],
  minify: false,
  sourcemap: false,
  logLevel: 'info',
})

// index.html (with a CSP that matches the AGH web posture) + css path wiring.
const css = readFileSync(join(dist, 'app.css'), 'utf8')
const pvCss = readFileSync(join(pkg, '../protein-view/extensions/main/client/index.css'), 'utf8')
writeFileSync(join(dist, 'app.css'), `${pvCss}\n${css}\n`)
cpSync(join(pkg, 'client/index.html'), join(dist, 'index.html'))
renameSync(join(dist, 'server.js'), join(dist, 'server.mjs'))
console.log('[protein-platform] build complete → dist/')
