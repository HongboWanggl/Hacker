// Batch prediction: fetch + fold several UniProt accessions in one tool call.
// Reuses the registered uniprot_fetch / predict_structure tool specs directly
// (captured via a stub apply), so batch jobs behave exactly like single runs —
// same endpoints, same workspace layout, same confidence reports. Per-job
// failures are recorded and never abort the batch.

import { predictStructure, uniprotFetch } from './index.mjs'

const Kind = Symbol.for('TypeBox.Kind')

const MAX_JOBS = 8
const AA_RE = /^[ACDEFGHIKLMNPQRSTVWYBXZUO]+$/i

const text = (s) => ({ content: [{ type: 'text', text: s }] })
const result = (structured, _s) => ({
  content: [{ type: 'text', text: JSON.stringify(structured) }],
  structured,
})
const fail = (s) => ({ ...text(s), isError: true })

const str = (desc, extra = {}) => ({ [Kind]: 'String', type: 'string', description: desc, ...extra })

// Pull a registered tool spec out of its definition module without touching
// host state. Uses the individual exports, NOT the manifest — the manifest now
// includes batch_predict itself, which would recurse.
function extractTool(toolDef, name) {
  const captured = []
  toolDef.apply({ extension: () => ({ registerTool: (t) => captured.push(t) }) })
  const spec = captured.find((t) => t.name === name)
  if (!spec) throw new Error(`internal: tool ${name} not found`)
  return spec
}

const meta = {
  isReadOnly: false,
  isDestructive: false,
  isConcurrencySafe: false, // sequential by design (polite to the free ESMFold endpoint)
  isOpenWorld: false,
  replay: 'idempotent',
  costHint: undefined,
  deferLoading: false,
  requiresApproval: 'never',
}

export const batchPredictor = {
  inject: ['extension'],
  apply(ctx) {
    const agnes = ctx.extension()
    const fetchSpec = extractTool(uniprotFetch, 'uniprot_fetch')
    const predictSpec = extractTool(predictStructure, 'predict_structure')

    agnes.registerTool({
      name: 'batch_predict',
      description:
        'Predict structures for several UniProt accessions in one call (up to 8). For each accession: fetch the sequence, run ESMFold, save the PDB, and report mean pLDDT + low-confidence segments. Per-job failures are listed, not fatal. Free; runs sequentially and takes roughly 10-30 s per protein.',
      parameters: {
        [Kind]: 'Object',
        type: 'object',
        properties: {
          accessions: str('Comma- or space-separated UniProt accessions, e.g. "P04637 P61626"'),
        },
        required: ['accessions'],
        additionalProperties: false,
      },
      meta,
      async execute({ accessions }, tctx) {
        const list = [
          ...new Set(
            String(accessions)
              .split(/[\s,;]+/)
              .map((a) => a.trim().toUpperCase())
              .filter(Boolean),
          ),
        ]
        if (list.length === 0) return fail('No accessions given. Example: "P04637 P61626".')
        if (list.length > MAX_JOBS)
          return fail(
            `Too many accessions (${list.length}). Batch supports up to ${MAX_JOBS}; run the rest separately.`,
          )

        const jobs = []
        for (const acc of list) {
          if (!/^[OPQ][0-9][A-Z0-9]{3}[0-9]|[A-NR-Z][0-9][A-Z][A-Z0-9]{2}[0-9]$/.test(acc)) {
            jobs.push({ accession: acc, status: 'failed', error: 'not a valid UniProt accession' })
            continue
          }
          let sequence
          let proteinName
          try {
            const fetched = await fetchSpec.execute({ accession: acc }, tctx)
            if (fetched.isError) {
              jobs.push({
                accession: acc,
                status: 'failed',
                error: (fetched.content?.[0]?.text ?? 'fetch failed').slice(0, 200),
              })
              continue
            }
            sequence = fetched.structured?.sequence
            proteinName = fetched.structured?.proteinName
          } catch (error) {
            jobs.push({ accession: acc, status: 'failed', error: String(error).slice(0, 200) })
            continue
          }
          if (!sequence || !AA_RE.test(sequence) || sequence.length < 10) {
            jobs.push({ accession: acc, status: 'failed', error: 'sequence missing or invalid after fetch' })
            continue
          }
          try {
            const predicted = await predictSpec.execute({ sequence, name: acc }, tctx)
            if (predicted.isError) {
              jobs.push({
                accession: acc,
                name: proteinName,
                status: 'failed',
                error: (predicted.content?.[0]?.text ?? 'prediction failed').slice(0, 200),
              })
              continue
            }
            const r = predicted.structured ?? {}
            jobs.push({
              accession: acc,
              name: proteinName,
              status: 'ok',
              savedTo: r.savedTo,
              residues: r.residues,
              meanPlddt: r.meanPlddt,
              lowSegments: r.lowConfidenceSegments?.length ?? 0,
              verdict: r.verdict,
            })
          } catch (error) {
            jobs.push({
              accession: acc,
              name: proteinName,
              status: 'failed',
              error: String(error).slice(0, 200),
            })
          }
          // Small gap between folds — the ESMFold endpoint is a free shared service.
          if (list.length > 1) await new Promise((r) => setTimeout(r, 1500))
        }

        const ok = jobs.filter((j) => j.status === 'ok')
        const meanOfMeans = ok.length
          ? Math.round((ok.reduce((s, j) => s + j.meanPlddt, 0) / ok.length) * 10) / 10
          : undefined
        const summary = {
          total: jobs.length,
          ok: ok.length,
          failed: jobs.length - ok.length,
          ...(meanOfMeans !== undefined ? { meanPlddt: meanOfMeans } : {}),
        }
        return result({ jobs, summary }, JSON.stringify({ summary, jobs }))
      },
    })
  },
}
