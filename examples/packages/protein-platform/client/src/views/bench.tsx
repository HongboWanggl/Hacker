import { useEffect, useState } from 'react'

// Benchmark view: the platform's predictions scored against CASP14 public
// targets' experimental structures — the mainstream way to say "this pipeline
// works". Scoring (Cα-lDDT, CA-RMSD) happens server-side on demand from the
// archives; this view is a pure read of api/bench.

type BenchRow = {
  id: string
  name: string
  pdb: string
  chain: string
  length: number
  status: 'done' | 'pending'
  taskId?: string
  meanPlddt?: number
  lddt?: number
  rmsd?: number
  nAligned?: number
}

type BenchData = {
  set: string
  rows: BenchRow[]
  calib: Array<{ bin: number; n: number; meanLddt: number }>
  scored: number
  updatedAt: string
}

// AlphaFold pLDDT palette — reused for lDDT so "what is a good number" reads
// with the same colors everywhere in the product.
function band(v: number): string {
  return v >= 90 ? 'b-hi' : v >= 70 ? 'b-ok' : v >= 50 ? 'b-lo' : 'b-bad'
}

function CalibChart({ calib }: { calib: NonNullable<BenchData['calib']> }) {
  const W = 360
  const H = 130
  const PAD = 26
  const bw = (W - PAD * 2) / 10
  const bar = (bin: number) => calib.find((c) => c.bin === bin)
  return (
    <svg className="pl-cal" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="pLDDT 校准">
      {Array.from({ length: 10 }, (_, b) => {
        const c = bar(b * 10)
        const x = PAD + b * bw + 2
        const w = bw - 4
        if (!c) return <rect key={b} x={x} y={H - PAD} width={w} height={0.01} fill="none" />
        const h = (H - PAD * 2) * Math.min(1, c.meanLddt)
        return (
          <g key={b}>
            <rect
              x={x}
              y={H - PAD - h}
              width={w}
              height={h}
              rx={2}
              className={`cal-bar ${band(c.meanLddt * 100)}`}
            />
            <text x={x + w / 2} y={H - PAD - h - 4} textAnchor="middle" className="cal-num">
              {c.meanLddt.toFixed(2)}
            </text>
            <text x={x + w / 2} y={H - PAD + 12} textAnchor="middle" className="cal-bin">
              {b * 10}
            </text>
          </g>
        )
      })}
      {/* ideal-calibration diagonal: per-residue lDDT ≈ pLDDT/100 */}
      <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={PAD} className="cal-diag" />
      <text x={PAD - 4} y={PAD + 4} textAnchor="end" className="cal-bin">
        lDDT
      </text>
      <text x={W - PAD + 6} y={H - PAD + 4} className="cal-bin">
        pLDDT
      </text>
    </svg>
  )
}

export function BenchView() {
  const [data, setData] = useState<BenchData | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    fetch(new URL('api/bench', location.href.split('#')[0]))
      .then((r) => r.json())
      .then((d) => {
        if (alive) setData(d)
      })
      .catch(() => {
        if (alive) setFailed(true)
      })
    return () => {
      alive = false
    }
  }, [])
  if (failed)
    return (
      <main className="pl-page">
        <div className="pl-empty">基准数据加载失败 — 稍后刷新试试</div>
      </main>
    )
  if (!data)
    return (
      <main className="pl-page">
        <div className="pl-empty">正在加载基准数据…</div>
      </main>
    )
  const done = data.rows.filter((r) => r.status === 'done')
  return (
    <main className="pl-page">
      <div className="pl-wall-title">平台基准 · CASP14 公开靶标</div>
      <p className="pl-bench-note">
        用实验解析结构（PDB）给平台自己的预测打分，指标与国际评估同口径： <b>Cα-lDDT</b>（CASP/CAMEO
        主指标，越高越好，0–1）与叠合后 <b>Cα-RMSD</b>（Å，越低越好）。 预测由本平台管线端到端产生（Boltz-2
        推理），靶标序列取自 CASP14 官方序列文件，预测时对平台「盲测」。
        校准图检查模型自信度是否诚实：每柱是落入该 pLDDT 区间的残基的实测 lDDT，柱高贴着对角线 = 自信度可信。
      </p>
      <table className="pl-bench-table">
        <thead>
          <tr>
            <th>靶标</th>
            <th>蛋白</th>
            <th>实验结构</th>
            <th className="num">残基</th>
            <th className="num">平均 pLDDT</th>
            <th className="num">Cα-lDDT</th>
            <th className="num">Cα-RMSD (Å)</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.id}>
              <td className="bench-id">{r.id}</td>
              <td className="bench-name">{r.name || '—'}</td>
              <td>
                <a href={`https://www.rcsb.org/structure/${r.pdb}`} target="_blank" rel="noreferrer">
                  {r.pdb} {r.chain}
                </a>
              </td>
              <td className="num">{r.length}</td>
              {r.status === 'done' ? (
                <>
                  <td className="num">
                    {typeof r.meanPlddt === 'number' ? (
                      <span className={`pill ${band(r.meanPlddt)}`}>{r.meanPlddt.toFixed(1)}</span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="num">
                    {typeof r.lddt === 'number' ? (
                      <span className={`pill ${band(r.lddt * 100)}`}>{r.lddt.toFixed(3)}</span>
                    ) : (
                      '未评分'
                    )}
                  </td>
                  <td className="num">{typeof r.rmsd === 'number' ? r.rmsd.toFixed(2) : '—'}</td>
                </>
              ) : (
                <td colSpan={3} className="num bench-pending">
                  {r.taskId ? '归档不完整' : '待运行'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {done.length > 0 && (
        <div className="pl-bench-cal">
          <div className="pl-bench-sub">pLDDT 校准（{done.length} 个靶标，逐残基）</div>
          <CalibChart calib={data.calib} />
        </div>
      )}
      <p className="pl-bench-note">
        参考结构：RCSB 实验解析（X 射线 / 冷冻电镜），仅取与靶标序列一致匹配的链段； 指标实现：平台内置
        Cα-lDDT（Mariani et al. 2013 定义，四阈值 0.5/1/2/4 Å、15 Å 包含半径）。 已完成 {data.scored} /{' '}
        {data.rows.length} 个靶标。靶标集来源：
        <a href="https://predictioncenter.org/casp14/" target="_blank" rel="noreferrer">
          predictioncenter.org/casp14
        </a>
        。
      </p>
    </main>
  )
}
