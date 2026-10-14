# 运行证据 · AGH 原生导出文件

本目录是《4-运行与验证证据》§一「AGH 执行记录」的**实际交付文件**，
由 **Agnes Harness 原生机制**从平台 daemon 的会话账本直接导出，
非事后整理、非人工誊写。提供两种原生导出途径：

| 途径 | 产物 | 说明 |
| --- | --- | --- |
| **A · AGH 原生 Web 前端按钮导出** | `AGH原生前端导出-诊断包-2941195d.zip` | 在 AGH 自带 Web UI 中打开平台会话，点右上角「Report a problem」按钮，经 Share diagnostics → Generate package → Save ZIP 三步下载 |
| **B · AGH CLI `agnes export` 命令** | `AGH执行记录-0*.{html,jsonl}` | 在服务器上对同一 daemon 执行原生导出命令 |

两种途径读的是**同一个 daemon 的同一条会话账本**，可交叉印证。

每个会话（途径 B）两份：

- `*.html` —— 自包含单文件轨迹视图（会话 ID、导出时间、脱敏标记、时间线节点），浏览器直接打开；
- `*.jsonl` —— 原始协议事件流，一行一个事件信封，供逐条复核。

## 文件清单

| 文件 | 对应平台任务 | 工具调用链 |
| --- | --- | --- |
| --- | --- | --- |
| `AGH执行记录-01-P69905单体.html` / `.jsonl` | taskId `tmv8foc7xfimt`，血红蛋白 α（P69905，141 aa），平均 pLDDT 96.7 | `uniprot_fetch` → `predict_structure` → `analyze_confidence` |
| `AGH执行记录-02-复合物.html` / `.jsonl` | taskId `tmv8cu0wqq606`，双链 + 配体 SMILES，平均 pLDDT 77.9 | `predict_complex`（Boltz-2 多链，含 PAE / ipTM） |
| `AGH执行记录-03-CASP14-T1025.html` / `.jsonl` | taskId `tmv84cr0xxr66`，CASP14 靶标 T1025，平均 pLDDT 94.6（实测 Cα-lDDT 0.952、Cα-RMSD 0.65 Å） | `predict_structure` → `analyze_confidence` |

三份分别对应《6-提交填报单》§五的正常样例、复合物样例与基准靶标样例。

## 导出方式（可复现）

```bash
# 在部署了平台 daemon 的服务器上执行（本目录文件即由下列命令产出）
cd <agnes-harness 仓库>
AGH_HOME=<数据目录> AGNES_PROFILE=local-dev \
  node packages/cli/dist/local/agnes.mjs sessions          # 列出会话，第二列为事件数

# HTML 轨迹视图
AGH_HOME=<数据目录> AGNES_PROFILE=local-dev \
  node packages/cli/dist/local/agnes.mjs export <sessionId> --html --out <输出.html>

# 原始协议事件流（默认 agnes 格式，一行一个事件信封）
AGH_HOME=<数据目录> AGNES_PROFILE=local-dev \
  node packages/cli/dist/local/agnes.mjs export <sessionId> --out <输出.jsonl>
```

`agnes export` 还支持 `--format sharegpt` 与 `--format claude-code` 两种互换格式。

## 脱敏说明

导出走 AGH 共享隐私实现：默认（不带 `--raw`）会对密钥、绝对路径与个人标识做脱敏，
因此 HTML 页眉标注 `redacted`，JSONL 中的会话 ID 亦为脱敏后的值。
本目录文件均为默认脱敏导出，不含任何凭据。

## 事件类型速查

JSONL 每行一个事件信封，常见类型：

| 类型 | 含义 |
| --- | --- |
| `session/start` / `turn/start` / `turn/end` | 会话与轮次边界 |
| `user/message` | 用户注入的任务提示词（含任务类型与执行约束） |
| `step/start` / `step/end` | agent 的单步规划 |
| `request/header` / `request/sent` | 发往模型的请求（含模型路由与上下文规模） |
| `assistant/message` | 模型的中间输出 |
| `tool/call` / `tool/result` | 工具调用的开启与结果（成对出现，即「调用链」） |
| `cost/ledger` / `budget.state` | 用量与预算状态 |
| `verifier/signal` | 校验信号 |
| `assistant/output` | 本轮最终输出 |

---

## 途径 A · AGH 原生 Web 前端按钮导出（`AGH原生前端导出-诊断包-2941195d.zip`）

这是在 **AGH 自带的 Web 界面**上点按钮得到的完整证据包，与 CLI 导出同源同账本。

**操作路径**（2026-10-15 实测）：启动 AGH Web UI → 左侧「Workspaces and sessions」列表中出现平台任务（同一 daemon）→ 点开「蛋白质三维结构预测与置信度分析」→ 右上角点 **Report a problem** 图标按钮 → Share diagnostics → Generate package → Save ZIP。

**ZIP 内容**（7 个文件，196 KB）：

| 文件 | 内容 |
| --- | --- |
| `index.html` | 自包含诊断查看器（浏览器直接打开） |
| `events.jsonl` | 会话完整事件流（一行一个协议事件信封，41 KB） |
| `trace.json` | 轨迹投影：`sessionId`、`turns`、`nodes`（18 个）、`budget`、`usage`（input 9662 / output 274 / cacheRead 39936 tokens） |
| `system.json` | 环境与配置：AGH 版本、Node 24.19.0、profile `local-dev`、模型路由 `agnes-3.0-flash`（200K 上下文）与 `doubao-seed-2-0-pro-260215`（256K） |
| `logs/daemon.jsonl`、`logs/host.jsonl`、`logs/browser.json` | daemon / 宿主 / 浏览器三侧日志，时间戳可交叉印证 |

**脱敏**：导出经 AGH 共享隐私实现自动脱敏；另将 AGH 漏脱的一处 agent runtime context `cwd` 绝对路径替换为 `<workspace>` 占位符（仅环境信息，不影响执行记录）。交付前已扫描：password / token / apiKey / Bearer / 私钥 **0 命中**，`/Users/*`、`/home/*` 路径 **0 残留**。

**界面实拍**（见参赛材料 `images/`）：`shot-agh-web-session-2026-10-15.png`（原生 UI 中打开的平台会话，含 Conversation / Trace 双页签、工具调用提示词、完成结论、`agnes-3.0-flash`、耗时 8.8 s）、`shot-agh-web-dialog-2026-10-15.png`（Report a problem 对话框）、`shot-agh-web-saved-2026-10-15.png`（保存成功）。
