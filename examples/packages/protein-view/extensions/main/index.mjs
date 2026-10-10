// Backend runtime for @aghes/protein-view.
// Exposes one query service, `protein.structure`, that reads a predicted PDB from the
// session workspace and returns the CA-atom backbone with per-residue pLDDT so the
// browser panel can render without any file access of its own.

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
  },
}
