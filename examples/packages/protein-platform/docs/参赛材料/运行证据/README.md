# 运行证据 · AGH 原生导出文件

本目录是《4-运行与验证证据》§一「AGH 执行记录」的**实际交付文件**，
由 **Agnes Harness CLI 原生 `agnes export` 命令**从平台 daemon 的会话账本直接导出，
非事后整理、非人工誊写。每个会话两份：

- `*.html` —— 自包含单文件轨迹视图（会话 ID、导出时间、脱敏标记、时间线节点），浏览器直接打开；
- `*.jsonl` —— 原始协议事件流，一行一个事件信封，供逐条复核。

## 文件清单

| 文件 | 对应平台任务 | 工具调用链 |
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
