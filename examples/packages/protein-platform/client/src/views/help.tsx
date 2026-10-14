import { createElement as h } from 'react'

// In-product usage guide (#/help). Biologists never read the repo README —
// this is the documentation surface they actually see: how to phrase input,
// what each result artifact means (pLDDT bands, PAE, AlphaFold compare), and
// what the workbench can do. Static content, no services involved.

const PLDDT_BANDS = [
  { color: '#0053D6', range: '≥ 90', label: '很高', note: '骨架原子位置可信到 ~0.5 Å，可放心用于机制讨论' },
  { color: '#65CBF3', range: '70–90', label: '高', note: '整体折叠可靠，侧链细节建议核对' },
  { color: '#FFDB13', range: '50–70', label: '中', note: '趋势可参考，具体构象谨慎解读' },
  { color: '#FF7D45', range: '< 50', label: '低', note: '大概率是无序区 / 环区，勿当结构证据' },
]

function Section({ title, children }: { title: string; children: any }) {
  return (
    <section className="pl-help-sec">
      <h2>{title}</h2>
      {children}
    </section>
  )
}

export function HelpView() {
  return (
    <main className="pl-page pl-help">
      <div className="pl-wall-title">使用指南</div>

      <Section title="① 三种输入，自动识别">
        <div className="pl-help-grid">
          <div className="pl-help-card">
            <h3>UniProt ID</h3>
            <p>直接输入登录号，如 <code>P69905</code>（血红蛋白 α 链）。平台自动获取序列并预测。</p>
          </div>
          <div className="pl-help-card">
            <h3>FASTA</h3>
            <p>粘贴标准 FASTA，取第一条序列，标题行作为任务名。多条记录请用「批量预测」。</p>
          </div>
          <div className="pl-help-card">
            <h3>原始序列</h3>
            <p>纯氨基酸字母（≥10 个）也可直接粘贴，如突变体序列 <code>MVLSPADKTNVKAAWGK…</code>。</p>
          </div>
        </div>
      </Section>

      <Section title="② 选对任务类型">
        <div className="pl-help-grid">
          <div className="pl-help-card">
            <h3>单体结构预测</h3>
            <p>一条链 → ESMFold 折叠 + 置信度分析。最适合快速看一个蛋白长什么样、哪里可信。</p>
          </div>
          <div className="pl-help-card">
            <h3>复合物预测</h3>
            <p>每行一条链 + 可选配体 SMILES（如阿司匹林 <code>CC(=O)OC1=CC=CC=C1C(=O)O</code>）→ Boltz-2，附 PAE 链间误差热图。</p>
          </div>
          <div className="pl-help-card">
            <h3>批量预测</h3>
            <p>每行一个 UniProt ID（≤8 个）→ 一次跑完，逐目标展开 3D 详情，一屏比较同源蛋白。</p>
          </div>
        </div>
      </Section>

      <Section title="③ 怎么读结果">
        <div className="pl-help-card pl-help-wide">
          <h3>pLDDT 置信度色标（3D 结构按此着色）</h3>
          <ul className="pl-help-bands">
            {PLDDT_BANDS.map((b) => (
              <li key={b.range}>
                <span className="pl-help-swatch" style={{ background: b.color }} />
                <b>{b.range}</b> {b.label} — {b.note}
              </li>
            ))}
          </ul>
        </div>
        <div className="pl-help-grid">
          <div className="pl-help-card">
            <h3>置信度曲线</h3>
            <p>沿序列逐残基的 pLDDT；低谷段就是模型的「心虚区」，常对应环区或无序区。</p>
          </div>
          <div className="pl-help-card">
            <h3>PAE 热图（复合物）</h3>
            <p>链内亮、链间也亮 = 两个链的相对位置可信；链间暗 = 接口摆放是猜的。</p>
          </div>
          <div className="pl-help-card">
            <h3>AlphaFold DB 对比</h3>
            <p>单体结果页点「⇄ 与 AlphaFold DB 对比」：与官方参考模型算 RMSD、逐段差值。核心区 ~0.3 Å 即高度一致。</p>
          </div>
        </div>
      </Section>

      <Section title="④ 工作台能做的事">
        <ul className="pl-help-list">
          <li><b>检索 → 预测</b>：「检索」页搜关键词（如 hemoglobin），行内 ▶ 一键预测；勾选多个可批量。</li>
          <li><b>任务管理</b>：任务列表可取消运行中的任务（两键确认防误触）；失败/已取消的任务可一键按原输入重提。</li>
          <li><b>分享报告</b>：结果页「⇩ 分享报告」生成自包含 HTML（评分 + 3D/曲线快照 + 完整 JSON），可直接进幻灯片或邮件。</li>
          <li><b>历史归档</b>：所有完成的任务自动归档；换浏览器、清存储、重启服务后结果页仍完整可交互，归档单体页还能直接发起 AlphaFold 对比。</li>
        </ul>
      </Section>

      <Section title="⑤ 常见问题">
        <ul className="pl-help-list">
          <li><b>一个任务要多久？</b>单体约 1–3 分钟；复合物 / 批量更久（Boltz-2 计算量大）。运行中可随时取消。</li>
          <li><b>任务失败了？</b>模型网关与预测服务的偶发抖动（超时、限流、连接中断等），平台最多自动重试两次；仍失败时点「↻ 重新提交此任务」即可，输入原样重放。</li>
          <li><b>能预测突变体吗？</b>能——把突变后的序列当原始序列粘贴（单体），或放进复合物的链里。</li>
          <li><b>结果可以引用吗？</b>本平台的预测由 ESMFold / Boltz-2 生成，学术引用请指向相应模型论文；分享报告中的 JSON 含完整参数可复核。</li>
        </ul>
      </Section>

      <div className="pl-help-foot">
        准备好了？回<a href="#/">首页</a>提交第一个预测，或在<a href="#/search">检索</a>页找一个感兴趣的蛋白。
      </div>
    </main>
  )
}
