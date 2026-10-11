// fetchRetry: 5xx once → retried; 4xx → no retry; network throw → retried; ok → single call.
import { fetchRetry } from '/Users/wanghanbao/agnes-harness/examples/packages/protein-predictor/index.mjs'

const ok = (name: string, cond: boolean) => {
  console.log(cond ? 'ok ' : 'FAIL', name)
  if (!cond) process.exitCode = 1
}

let calls = 0
const flaky = async () => {
  calls++
  if (calls === 1) return { status: 502, ok: false }
  return { status: 200, ok: true }
}
const r1 = await fetchRetry(flaky, 'http://x')
ok('5xx retried once (2 calls)', calls === 2 && r1.status === 200)

calls = 0
const bad = async () => {
  calls++
  return { status: 404, ok: false }
}
const r2 = await fetchRetry(bad, 'http://x')
ok('4xx not retried (1 call)', calls === 1 && r2.status === 404)

calls = 0
const drop = async () => {
  calls++
  if (calls === 1) throw new Error('ECONNRESET')
  return { status: 200, ok: true }
}
const r3 = await fetchRetry(drop, 'http://x')
ok('network error retried', calls === 2 && r3.status === 200)

calls = 0
const dead = async () => {
  calls++
  throw new Error('down')
}
let threw = false
try {
  await fetchRetry(dead, 'http://x')
} catch {
  threw = true
}
ok('second failure propagates', threw && calls === 2)
