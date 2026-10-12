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
| 首页 | 极简输入框（FASTA / UniProt ID / 原始序列自动识别）+ 类型选择（单体 / 复合物 / 批量）+ 最近预测报告墙 |
| 复合物 | 每行一条链 + 可选配体 SMILES → predict_complex（Boltz-2）→ 界面置信度结果页 |
| 批量 | 每行一个 UniProt ID（≤8）→ batch_predict → BatchCard 汇总，成功行可展开逐目标 3D 详情 |
| 检索 | UniProt 关键词检索 → SearchCard hits 列表 |
| 任务页 | 全部任务列表（运行中/已完成/失败徽标），自动合并 surface 归档历史 |
| 结果页 | 3D 骨架画布（按 pLDDT 着色、自动旋转、全屏）+ 置信度曲线 + 序列条 + 分段统计 + PNG/CSV/PDB 导出；单体任务可一键发起 AlphaFold DB 对比 |
| 历史归档 | 单体/复合物任务完成时报告 JSON + PDB 落盘到 surface archive；换浏览器/清存储/重启 daemon 后结果页仍完整可交互 |

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
  report.json + model.pdb，≤2MiB）。meta 冗余 meanPlddt/verdict 供报告墙免取数渲染。
  PDB 结构解析在 server 侧复用同一 parser，返回与活 BFF 完全同形的 protein.structure 输出。

## 验证

dev-tests 下的 live 探针（按链路全覆盖；需要本机 daemon + 已发布平台）：

```bash
node ../../dev-tests/pp-platform-live.mjs --shots   # 单体全流程：提交→阶段→3D/曲线→截图
node ../../dev-tests/pp-archive-roundtrip.mjs       # 归档往返：完成→archived→无 localStorage 新上下文→API 直查
node ../../dev-tests/pp-complex-full.mjs            # 复合物全流程：双链→内联报告渲染→归档（含 PAE）→新上下文
node ../../dev-tests/pp-batch-smoke.mjs             # 批量：2 个 accession→BatchCard 汇总
node ../../dev-tests/pp-search-smoke.mjs            # 检索：uniprot_search→SearchCard hits
node ../../dev-tests/pp-compare-smoke.mjs           # AlphaFold 对比：一键发起→CompareCard（RMSD/差值轮廓）
```

## 公网部署要点（WSL 服务器）

- daemon WS 端口钉死（user unit `--local-web-addr 127.0.0.1:46119`，localWeb 模式下 WS 同端口）。
- Caddy `/agnesd*`：`header_up Host 127.0.0.1:46119` + `header_up Origin http://127.0.0.1:4177`
  + `flush_interval -1`（Host 写 4177 会被 WS 升级校验 403）。
- 公网 wsUrl 覆盖走 deploy 树 `surfaces/main.json` 的 `config.wsUrl`（发布时
  `PP_SURFACE_WS_URL=wss://<host>/agnesd` 注入；surface 子进程 env 是白名单，env 传不进去）。
