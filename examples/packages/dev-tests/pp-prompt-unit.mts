// The task prompts are product behaviour: the agent follows them literally, so a
// sentence here is a decision about what the platform can do.
//
// The bug this file pins (2026-10-15): a previous edit told the agent to stop at
// any length refusal, meaning to stop the >1000 case from calling
// analyze_confidence on a structure that was never written. But "序列过长而拒绝"
// also describes ESMFold's ~400 aa wall, so every chain of 400–1000 aa — exactly
// the range predict_complex exists for — died in 24 s with the 413 text instead of
// being folded. Two walls, two different instructions; this asserts they stay
// distinct.
//
// The prompt is imported from the product, never copied: a probe that drifts from
// what users actually submit stops being evidence.
import { buildPrompt } from '../protein-platform/client/src/prompts.ts'

let failed = 0
const ok = (name: string, cond: boolean, extra = '') => {
  console.log(cond ? 'ok ' : 'FAIL', name, extra)
  if (!cond) failed++
}

// --- single: the two length branches -----------------------------------------
{
  const p = buildPrompt('single', { accession: 'P10275', name: 'ar_920' })
  ok('single keeps the numbered plan', /1\)[\s\S]*2\)[\s\S]*3\)/.test(p), p.slice(0, 160))
  ok('single fetches the accession first', p.includes('uniprot_fetch') && p.includes('P10275'))
  ok('single names the ESMFold wall', /413|400/.test(p))
  ok('single names the hard ceiling', p.includes('1000'))

  // The load-bearing assertion: the ESMFold branch must hand off to
  // predict_complex, and must NOT be a stop instruction.
  const [esmfoldBranch, rest] = p.split(/如果 predict_complex/)
  ok('the ESMFold branch continues into predict_complex', /predict_complex/.test(esmfoldBranch))
  ok('the ESMFold branch does not stop the run', !/立即停止/.test(esmfoldBranch), esmfoldBranch.slice(0, 200))
  // (The plan itself names analyze_confidence as step 3 — that is the SUCCESS
  // path, so the check here is only that the ESMFold branch does not stop early.)

  // …and the >1000 / compute-failure branch IS the stop instruction.
  ok('the ceiling branch exists', !!rest)
  ok('the ceiling branch stops the run', /立即停止/.test(rest), rest.slice(0, 160))
  ok('the ceiling branch forbids analyze_confidence', /不要调用 analyze_confidence/.test(rest))
  ok('the ceiling branch asks for the tool text verbatim', /逐字复述/.test(rest))
  ok('the ceiling branch forbids re-running the same fold', /不要用同样的输入重跑/.test(rest))
  ok('the ceiling branch offers the domain-split route', /600/.test(rest) && /结构域/.test(rest))
  ok('the ceiling branch offers the API-key route', /API key/.test(rest))
}

// A pasted sequence has no accession: same plan minus the fetch.
{
  const p = buildPrompt('single', { sequence: 'MKTAYIAK'.repeat(10), name: 'pasted' })
  ok('pasted sequence skips uniprot_fetch', !p.includes('uniprot_fetch'))
  ok('pasted sequence still carries the ESMFold wall', /413|400/.test(p))
  ok('pasted sequence still carries both branches', /如果 predict_complex/.test(p) && p.includes('1000'))
  ok('pasted sequence is embedded', p.includes('MKTAYIAK'))
}

// --- complex: unchanged contract ---------------------------------------------
{
  const p = buildPrompt('complex', { sequences: ['AAAAA', 'BBBBB'], name: 'pair' })
  ok('complex names predict_complex', p.includes('predict_complex'))
  ok('complex labels both chains', /链 A: AAAAA/.test(p) && /链 B: BBBBB/.test(p))
  ok('complex passes the name through', p.includes('pair'))
  ok('complex has no length stop', !/立即停止/.test(p))
}
{
  const p = buildPrompt('complex', { sequences: ['AAAAA', 'BBBBB'], ligandSmiles: 'CCO', name: 'pair_lig' })
  ok('complex forwards the ligand', p.includes('CCO') && p.includes('ligand_smiles'))
}

console.log(failed === 0 ? 'PROMPT TESTS: PASS' : `PROMPT TESTS: ${failed} FAILURES`)
process.exit(failed === 0 ? 0 : 1)
