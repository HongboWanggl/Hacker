// Live composer feedback: pure input analysis for the home composer's inspect
// strip — surface what the platform understood from a paste, and what will be
// silently dropped, *before* the user commits a task. Kept free of React so it
// stays trivially probe-able.

export type Chip = { tone: 'ok' | 'warn'; text: string }

// Same accession shape the submit path accepts (isoform suffix included).
const ACCESSION = /^(?:[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9])(?:-\d+)?$/i

// Split a FASTA blob into record sequences (header lines delimit; whitespace
// stripped). Mirrors what the single-chain submit path consumes.
export function fastaRecords(text: string): string[] {
  const records: string[] = []
  let cur = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('>')) {
      records.push(cur)
      cur = ''
    } else {
      cur += line.replace(/\s/g, '')
    }
  }
  records.push(cur)
  return records
}

export function analyzeInput(text: string, type: 'single' | 'complex' | 'batch'): Chip[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  if (type === 'batch') {
    const tokens = trimmed.split(/[\n,;\s]+/).filter(Boolean)
    const ok = tokens.filter((t) => ACCESSION.test(t))
    const ignored = tokens.length - ok.length
    const chips: Chip[] = [{ tone: 'ok', text: `${Math.min(ok.length, 8)} 个 UniProt ID` }]
    if (ok.length > 8) chips.push({ tone: 'warn', text: '最多 8 个，仅取前 8 个' })
    if (ignored > 0) chips.push({ tone: 'warn', text: `${ignored} 项无法识别，将被忽略` })
    return chips
  }

  if (type === 'complex') {
    const lines = trimmed
      .split('\n')
      .map((l) => l.replace(/^>.*$/, '').replace(/[^A-Za-z]/g, '').toUpperCase())
    const usable = lines.filter((s) => s.length >= 5)
    const short = lines.filter((s) => s.length > 0 && s.length < 5).length
    const chips: Chip[] = []
    if (usable.length > 0)
      chips.push({
        tone: 'ok',
        text: `${usable.length} 条链 · 共 ${usable.reduce((s, l) => s + l.length, 0)} aa`,
      })
    if (short > 0) chips.push({ tone: 'warn', text: `${short} 条链不足 5 aa，将被忽略` })
    if (usable.length === 0 && short === 0) chips.push({ tone: 'warn', text: '未检测到序列' })
    return chips
  }

  // single
  if (trimmed.startsWith('>')) {
    const records = fastaRecords(trimmed).filter((s) => s.length > 0)
    const extras = records.length - 1
    const chips: Chip[] = []
    if (records.length > 0) {
      chips.push({ tone: 'ok', text: `FASTA · ${records[0].length} aa` })
      if (extras > 0) chips.push({ tone: 'warn', text: `共 ${records.length} 条记录，其余 ${extras} 条将忽略` })
    } else {
      chips.push({ tone: 'warn', text: 'FASTA 中未检测到序列' })
    }
    return chips
  }

  const letters = trimmed.replace(/[^A-Za-z]/g, '')
  if (ACCESSION.test(trimmed.replace(/\s/g, ''))) {
    return [{ tone: 'ok', text: `UniProt ID · ${trimmed.replace(/\s/g, '').toUpperCase()}` }]
  }
  if (letters.length >= 10 && /^[A-Za-z\s\n-]+$/.test(trimmed)) {
    return [{ tone: 'ok', text: `原始序列 · ${letters.length} aa` }]
  }
  if (letters.length >= 10) {
    return [{ tone: 'warn', text: '含数字或特殊字符，无法识别为序列' }]
  }
  return [{ tone: 'warn', text: '无法识别：请输入 UniProt ID、FASTA 或 ≥10 aa 的序列' }]
}
