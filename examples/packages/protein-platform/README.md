# protein-platform

面向生物学/医学人员的蛋白质结构预测平台 —— 以 AGH（daemon + worker + protein-predictor 插件 +
Ark 模型路由）为后端的独立 Surface 前端。用户视角是「结构预测工作台」：粘贴序列 / UniProt ID →
自动多阶段预测 → 交互式 3D 结构 + pLDDT 置信度报告，全程无需接触聊天 UI 或 agent 概念。

## 使用

```bash
# 构建（esbuild，产物在 dist/）
node tools/build.mjs

# 发布到本地 AGH（macOS local-dev）
AGH_HOME=$HOME/agh-home AGNES_PROFILE=local-dev \
  node --import tsx ../../dev-tests/agh-update-platform.mts
```

发布后 ≤8s 生效：本地 `http://127.0.0.1:4177/platform/`；服务器
`https://<host>/platform/`（Caddy basic_auth）。

## 功能

| 入口 | 说明 |
| --- | --- |
| 首页 | 极简输入框（FASTA / UniProt ID / 原始序列自动识别）+ 类型选择（单体 / 复合物 / 批量）+ 最近预测报告墙（归档卡带 Cα 主链缩略图，按 pLDDT 着色）+ 首次提交前的一次性自动化说明卡 |
| 复合物 | 每行一条链 + 可选配体 SMILES → predict_complex（Boltz-2）→ 界面置信度结果页 |
| 批量 | 每行一个 UniProt ID（≤8）→ batch_predict → BatchCard 汇总，成功行可展开逐目标 3D 详情 |
| 检索 | UniProt 关键词检索 → SearchCard hits 列表；行内 ▶ 一键预测该 hit，勾选后批条可「▶ 预测所选」（多选自动升级为批量任务，平台宿主独有；AGH 面板同组件仍是纯复制流） |
| 任务页 | 全部任务列表（运行中/已完成/失败/已取消徽标），自动合并 surface 归档历史；运行中行可两键取消（取消 → 确认取消，防误触） |
| 结果页 | 3D 骨架画布（按 pLDDT 着色、自动旋转、全屏）+ 置信度曲线 + 序列条 + 分段统计 + PNG/CSV/PDB 导出；单体任务可一键发起 AlphaFold DB 对比；复合物任务附 PAE 误差热图（链边界 + 悬停读数）；失败任务可一键重新提交（按存储的原始输入重放，compare 自动重种 PDB；已取消任务同样可重放）；运行中任务可在阶段进度卡里取消（两键确认，取消后不自动重试）；「⇩ 分享报告」生成自包含 HTML（评分徽标 + 3D/曲线快照 + 完整报告 JSON，可直接进幻灯片/邮件） |
| 历史归档 | 全部五类任务完成时落盘到 surface archive（单体/复合物：报告+模型+PAE；批量：汇总+逐目标 PDB；检索/对比：报告；对比还存参考模型供覆盖渲染）；换浏览器/清存储/重启 daemon 后结果页仍完整可交互；UniProt 来源的单体归档页可一键发起 AlphaFold DB 对比（PDB 从归档种入新会话，无需原任务在场）；任务页归档行可两键删除（✕ → 确认删除） |

## 使用示例

| 想做什么 | 在首页怎么输 |
| --- | --- |
| 预测血红蛋白 α 链 | 切到「单体结构预测」，输入 `P69905` → 开始预测。几分钟后报告墙出卡片：94.7 平均 pLDDT、分段质量条、点开即 3D |
| 自定义突变序列 | 粘贴原始序列（纯氨基酸字母，≥10 个），如 `MVLSPADKTNVKAAWGKVGAHAGEYGAEALERMFLSFPTTKTYFPHF` |
| FASTA 多条记录 | 直接粘贴 FASTA，取首条序列；标题行作任务名 |
| 两链复合物 + 配体 | 切到「复合物预测」，每行一条链序列，配体 SMILES 填进输入框（如 `CC(=O)OC1=CC=CC=C1C(=O)O` 阿司匹林）→ ipTM/配体结合置信度 + PAE 热图 |
| 一批同源蛋白 | 切到「批量预测」，每行一个 UniProt ID（≤8），完成后逐行展开 3D 详情 |
| 查蛋白再预测 | 「检索」页搜 `hemoglobin` → SearchCard 行内点 ▶ 直接预测该 hit；或勾选多个 → 「▶ 预测所选」批量预测 |
| 验证预测质量 | 单体结果页点「⇄ 与 AlphaFold DB 对比」→ 参考结构 RMSD / 差值轮廓，核心区 ~0.3 Å 即高度一致 |

## 架构

- **Surface**（`agnes.surfaces`，挂载 `/platform`）：node 进程静态伺服 SPA +
  `config.json`（wsUrl/profile/rowId/bffPath）+ archive API + `api/task`（代建任务目录）。
- **编排**（`client/src/orchestrator.ts`）：一任务一会话。`session/new {cwd: <tasksRoot>/<taskId>}`
  → 模板化 prompt（`prompts.ts`）→ ledger 归约（tool/call 开阶段、tool/result 收 savedTo、
  turn/end 定状态）。180s 无事件看门狗中止重试（STALL_WATCHDOG）。`onPermissionRequest` 自动
  allow（平台 prompt 只读科学管线，profile approvals 仍是主闸）。
- **数据面**（`client/src/bff.ts`）：同源 `POST /api/client-modules/service`
  `{profile,rowId:'web:@aghes/protein-view',sessionId,service,input}`，daemon 以该会话 workspace
  派发 protein-view 的 4 个服务（structure/report/pae/file）。归档任务走 `api/archive/*` 同形
  假服务，pv 组件无感知。
- **可视化**：直接 import protein-view 的 toolview 组件（`bindProteinToolViews` shim 捕获 +
  `ownerProps` 伪 owner——resultPreview 必须是**截断 JSON**，可解析 JSON 会使组件跳过 report
  重取）。解析器共享自 `protein-view/extensions/main/pdb-parse.mjs`（B-factor = pLDDT）。
- **归档**（`server/src/archive.ts`）：`~/protein-platform/archive/<taskId>/`（meta.json +
  report.json + model.pdb，批量另存逐目标 `pdb-<basename>`，≤2MiB）。meta 冗余 meanPlddt/verdict/
  jobPdbs 供报告墙免取数渲染（list 时推导并写回 meta.json，之后零解析开销）。
  PDB 结构解析在 server 侧复用同一 parser，返回与活 BFF 完全同形的 protein.structure 输出；
  `/structure?path=` `/file?path=` 按 basename 深链批内/对比参考 PDB（回退 model.pdb）。

## 验证

dev-tests 下的 live 探针（按链路全覆盖；需要本机 daemon + 已发布平台）：

```bash
node ../../dev-tests/pp-platform-live.mjs --shots   # 单体全流程：提交→阶段→3D/曲线→截图
node ../../dev-tests/pp-archive-roundtrip.mjs       # 归档往返：完成→archived→无 localStorage 新上下文→API 直查
node ../../dev-tests/pp-complex-full.mjs            # 复合物全流程：双链→内联报告渲染→归档（含 PAE）→新上下文
node ../../dev-tests/pp-batch-smoke.mjs             # 批量：2 个 accession→BatchCard→归档→新上下文重建
node ../../dev-tests/pp-search-smoke.mjs            # 检索：uniprot_search→SearchCard→归档→新上下文重建
node ../../dev-tests/pp-compare-smoke.mjs           # AlphaFold 对比：一键发起→CompareCard→归档→新上下文重建
node ../../dev-tests/pp-archive-delete.mjs          # 归档删除：POST 造档→任务页两键删除→服务端 404
node ../../dev-tests/pp-retry-smoke.mjs             # 失败重试：注入失败任务→重试按钮→新任务入列
node ../../dev-tests/pp-cancel-smoke.mjs            # 任务取消：真实任务→列表/结果页两键取消→徽标「已取消」
node ../../dev-tests/pp-share-report.mjs            # 分享报告：归档页⇩→下载 HTML→断言内嵌图/评分/JSON
node ../../dev-tests/pp-thumb-wall.mjs --shots      # 报告墙缩略图（批量卡=逐目标迷你迹线网格）
```

除 platform-live 外均支持远端模式：`PP_BASE`/`PP_USER`/`PP_PASS`（httpCredentials 注入，
针对公网部署回归）。

## 公网部署要点（WSL 服务器）

- daemon WS 端口钉死（user unit `--local-web-addr 127.0.0.1:46119`，localWeb 模式下 WS 同端口）。
- Caddy `/agnesd*`：`header_up Host 127.0.0.1:46119` + `header_up Origin http://127.0.0.1:4177`
  + `flush_interval -1`（Host 写 4177 会被 WS 升级校验 403）。
- 公网 wsUrl 覆盖走 deploy 树 `surfaces/main.json` 的 `config.wsUrl`（发布时
  `PP_SURFACE_WS_URL=wss://<host>/agnesd` 注入；surface 子进程 env 是白名单，env 传不进去）。
