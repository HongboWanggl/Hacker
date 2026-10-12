// Shared PDB → structure parser (Cα backbone + HETATM ligands + B-factor pLDDT).
// Pure and dependency-free so both the protein-view extension services (Node) and
// the protein-platform surface server (archive-backed result rendering) use the
// exact same residue/ligand shapes — a copy would drift.

const AA3_TO_1 = {
  ALA: 'A',
  ARG: 'R',
  ASN: 'N',
  ASP: 'D',
  CYS: 'C',
  GLN: 'Q',
  GLU: 'E',
  GLY: 'G',
  HIS: 'H',
  ILE: 'I',
  LEU: 'L',
  LYS: 'K',
  MET: 'M',
  PHE: 'F',
  PRO: 'P',
  SER: 'S',
  THR: 'T',
  TRP: 'W',
  TYR: 'Y',
  VAL: 'V',
  ASX: 'B',
  GLX: 'Z',
  SEC: 'U',
  PYL: 'O',
  UNK: 'X',
}

const WATERS = new Set(['HOH', 'SOL', 'WAT', 'H2O', 'TIP3', 'TIP', 'DOD'])
const TWO_LETTER = new Set([
  'CL',
  'BR',
  'NA',
  'MG',
  'CA',
  'FE',
  'ZN',
  'MN',
  'CU',
  'NI',
  'CO',
  'SE',
  'LI',
  'K',
  'AL',
  'SI',
])

const elementOf = (name, col) => {
  const el = col.trim().toUpperCase()
  if (/^[A-Z]{1,2}$/.test(el)) return TWO_LETTER.has(el) ? el[0] + el.slice(1).toLowerCase() : el[0]
  const m = /^[0-9]*([A-Za-z]{1,2})/.exec(name.trim())
  if (!m) return 'C'
  const up = m[1].toUpperCase()
  return TWO_LETTER.has(up) ? up[0] + up[1].toLowerCase() : up[0]
}

/** Parse PDB text into the protein.structure service's output shape:
 *  { n, sequence, residues: [{i, chain, aa, x, y, z, b}], ligandAtoms?, ligandBonds? }.
 *  Throws when no Cα atoms are found (caller surfaces a useful error). */
export function parsePdbStructure(pdb) {
  const residues = []
  const seen = new Set()
  const chainOrder = new Map()
  // Ligand (HETATM) atoms: Boltz-2 writes predicted ligand poses into the
  // PDB next to the protein chains. Waters are skipped; the panel renders
  // the rest as element-colored balls. Capped — ligands are small, and a
  // huge HETATM block would bloat the 1 MiB result for no visual gain.
  const ligandAtoms = []
  for (const line of pdb.split('\n')) {
    if (line.startsWith('HETATM')) {
      if (WATERS.has(line.slice(17, 20).trim().toUpperCase())) continue
      if (ligandAtoms.length >= 400) continue
      const x = Number(line.slice(30, 38).trim())
      const y = Number(line.slice(38, 46).trim())
      const z = Number(line.slice(46, 54).trim())
      if (![x, y, z].every(Number.isFinite)) continue
      ligandAtoms.push({
        el: elementOf(line.slice(12, 16), line.slice(76, 78)),
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100,
        z: Math.round(z * 100) / 100,
      })
      continue
    }
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
  if (residues.length === 0) throw new Error('no CA atoms found in PDB')
  // Group by chain in file order, then by residue number — never interleave
  // chains (a flat i-sort would zigzag between two chains both numbered 1..n).
  residues.sort((a, b) => chainOrder.get(a.chain) - chainOrder.get(b.chain) || a.i - b.i)
  // ESMFold writes pLDDT on a 0-1 scale; AlphaFold-family files use 0-100. Normalize so the
  // browser panel can treat `b` as pLDDT/100 uniformly.
  const maxB = residues.reduce((m, r) => Math.max(m, r.b), 0)
  if (maxB > 0 && maxB <= 1.5) for (const r of residues) r.b = Math.round(r.b * 1000) / 10
  // Covalent bonds for the ligand by heavy-atom distance (PDBs from Boltz
  // carry no CONECT records); <2.0 Å is safely inside any heavy-atom bond.
  const extra = {}
  if (ligandAtoms.length > 0) {
    const bonds = []
    for (let a = 0; a < ligandAtoms.length; a++) {
      for (let b = a + 1; b < ligandAtoms.length; b++) {
        const d = Math.hypot(
          ligandAtoms[a].x - ligandAtoms[b].x,
          ligandAtoms[a].y - ligandAtoms[b].y,
          ligandAtoms[a].z - ligandAtoms[b].z,
        )
        if (d < 2.0) bonds.push([a, b])
      }
    }
    extra.ligandAtoms = ligandAtoms
    extra.ligandBonds = bonds
  }
  return {
    n: residues.length,
    sequence: residues.map((r) => r.aa).join(''),
    residues,
    ...extra,
  }
}
