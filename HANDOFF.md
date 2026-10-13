# 交接文档：蛋白质平台迭代（2026-10-13）

> 状态：**分享报告内嵌交互 3D 已落地**（本文件顶部），前端大测试 15/15 PASS（§3），
> 服务器与 main 同步至 ce0a870，公网部署健康。

## 追加完成项（第 16 轮）

- **分享报告内嵌可交互 3D 视图**（ce0a870，已上服务器双端验证）：
  - `report.ts`：ShareInput 增 `structure?: { residues, ligandAtoms }`；模板内嵌 ~150 行
    vanilla canvas 查看器（Cα 迹线 + pLDDT 着色球 + 配体元素色球；拖拽旋转/滚轮+双指缩放/
    双击复位/自动旋转开关；DPR 适配）。残基数 0 时整块不输出，报告优雅降级为静态快照。
  - `result.tsx`：shareReport 增 `structurePath` 分支——点击后（快照同步完成之后）尽力取
    structure：live 走 `getServices().call('protein.structure',{path:pdbPath})`，archived 走
    `archivedServices(id).call('protein.structure',{})`；失败静默。快照纪律未动（figs 仍同步取）。
  - 探针：`pp-share-report.mjs` 扩展为下载后**打开报告文件**断言画布真的画出来（彩色像素>200）、
    拖拽改变画面、滚轮缩放改变画面、默认自动旋转开；新增 `pp-share-live.mjs` 覆盖 live 分支
    （真实提交 P69905 → 未归档页分享 → 断言 viewer+残差+评分）。本机+公网双端 PASS；
    pp-wall-sort / pp-tasks-filter 公网回归 PASS。
  - 文档：README 功能行+探针清单、docs/操作手册.md §5、桌面 md+PDF 均已同步。

## 追加完成项（第 14 轮，大测试之后）

- **pp-guest-gate.mjs**（新探针）：锁 guest 只读闸门契约——whoami 身份、guest 无删除钮、
  DELETE 403（guest）/放行（owner，deleteArchive 对缺失 id 幂等返回 200）。本机+公网双端 PASS。
- **任务页加载态修复**：archived fetch 在途时显示「正在加载历史归档…」，空态只在加载完成后
  判定（修掉每次进任务页闪「还没有任务」的瑕疵；pp-tasks-filter 双端回归 PASS）。
- **报告墙排序**（新功能）：类型筛选 chips 旁加「最新 / 最高分」——最高分把历史池按 mean pLDDT
  降序（检索/对比等无分档案垫底），live 卡恒在前；pp-wall-sort 探针双端 PASS。
- README 功能表/探针清单、docs/操作手册.md、桌面 md+PDF 均已同步（PDF 用 /tmp/md2pdf.mjs 重生成）。

## 0. 一句话现状

产品功能清单 1-5 全部落地；「开始预测」已修；BFF 503 假回归已结案（§1）；
**前端功能大测试已完成：15/15 探针 PASS（§3）**；服务器已同步到最新（§2）。
下一个窗口可从 §5 遗留项/backlog 里挑，或做产品打磨。

## 1. BFF 503 结案报告（勿再排查）

- **真相**：BFF 从来没有回归。之前两轮被两个假象误导：
  1. **bogus sessionId 探针**：对不存在的 session，worker 抛
     `E_WORKSPACE_REQUIRED`（session-workspace-runtime.ts:321 `acquire`），被
     handler.ts:501-505 的 catch 掩盖——非数字 code 的错误全部 `packageError`→E_PACKAGE_STATE，
     于是呈现为 `SEMANTIC_REJECTED {reason:'E_PACKAGE_STATE'}`。真实 session 的 BFF 一直正常。
  2. **重启窗口期**：search 任务 tmv62hiepr4xe 的归档 503 发生在 daemon 重启中途（round-12
     pkill 重启打断在跑链路是已知教训）。
- **实证**：`examples/packages/dev-tests/pp-bff-probe.mts`（真实 workspace.add+session.new 流程）
  REAL-SESSION OK；`pp-search-smoke.mjs` 本地 PASS（SearchCard 渲染 + 归档落盘）。
  worker 审计 `~/agh-home/data/audit/host.jsonl` 里有 7174 条 service-call、02:40 就有成功的
  client-web 调用——审计是定位神器（daemon.jsonl 是 plugin.tree 事件，host.jsonl 才有 service-call）。
- **本轮顺手落地的两个小改**（已 typecheck+实测）：
  1. `packages/cli/launch/package-admin.ts`：BFF 503 时服务端 `console.warn('[bff] …')` 带
     真实 reason（页面仍统一 503，设计不变；日志落在 web-local 进程 stdout，本机 /tmp/agh-web.log）。
  2. `examples/packages/protein-platform/client/src/bff.ts`：`bffPost()` 对 502/503/504
     重试 2 次×1.5s——骑过重启窗口，任务归档写不再被瞬时 503 打断。
- **探针卫生**：误导性的 bogus-only 探针（原 packages/sdk/bff-probe.mts）已删除；
  真实 session 探针移到 `examples/packages/dev-tests/pp-bff-probe.mts`，以后怀疑 BFF 先跑它。

## 2. 服务器侧同步 —— ✅ 已完成（2026-10-13，详见 §3 末尾）

原待办（bff.ts 重试 + package-admin.ts 日志上服务器）已通过 git bundle 同步 + 服务器本地构建完成。
以后服务器同步流程：`git bundle create /tmp/agh-sync.bundle main ^<服务器HEAD>` → scp →
`git fetch /tmp/agh-sync.bundle main:from-mac && git merge --ff-only from-mac` → 服务器
`pnpm --filter @agnes/cli build:local` + platform `node tools/build.mjs` → republish **必带
PP_SURFACE_WS_URL=wss://hambobo.tail81da4f.ts.net/agnesd** → `systemctl --user restart
agnes-daemon agnes-web`。

本机两处改动需要上服务器（WSL，`ssh -F /dev/null -i ~/.ssh/agh_key -o IdentitiesOnly=yes
serverofWHB@100.91.157.78`，`export PATH=$HOME/.local/node24/bin:$PATH`）：

1. **bff.ts 重试**（platform client bundle）：本机 build 平台 → scp `dist/` 到服务器 deploy 目录 →
   republish **必须带 `PP_SURFACE_WS_URL=wss://hambobo.tail81da4f.ts.net/agnesd`**（否则 wsUrl
   被抹成 loopback，提交按钮又灰）→ `systemctl --user restart agnes-daemon`。
2. **package-admin.ts 日志**（launcher）：服务器若从 git 仓库跑，pull 后 rebuild cli dist +
   重启；若只 scp 过 dist，则同样 scp 对应产物。低优先——只是可观测性，不影响功能。

## 3. 主任务：前端功能大测试 —— ✅ 已完成（2026-10-13）

远端全套探针矩阵（公网 guest 身份）+ 本机两探针，**15/15 PASS**：

| 探针 | 本机 | 公网(guest) |
| --- | --- | --- |
| pp-platform-live --shots（单体全流程） | PASS | — |
| pp-help-smoke | PASS | — |
| pp-wall-filter / pp-tasks-filter / pp-composer-inspect | — | PASS |
| pp-search-smoke / pp-batch-smoke | — | PASS |
| pp-complex-full（含 PAE） | — | PASS |
| pp-compare-smoke / pp-batch-compare-smoke | — | PASS |
| pp-cancel-smoke / pp-retry-smoke / pp-share-report | — | PASS |
| pp-archive-roundtrip / pp-thumb-wall --shots | — | PASS |

过程中的两个发现（都已处理）：
1. **探针竞态**（已修 pp-complex-full/pp-composer-inspect）：composer 类型页签切换重渲染 textarea，
   冷加载远端页面 fill 落进旧节点 → 提交钮永 disabled。click 后 settle 400ms + 等 `.pl-inspect`
   解析条再提交。教训已入记忆 agh-web-ui-live-probes。
2. **Boltz-2 任务级偶发失败**（complex 一次任务 failed，重跑即过）——已知的 API 抖动类别，
   结果页有「↻ 重新提交」兜底，无需改代码。

服务器已同步到 3059a0d（bundle 方式，无 GitHub 出网）：platform dist 重发（带
PP_SURFACE_WS_URL）+ cli dist 重建 + daemon/web 重启，config.json 钉 wss:// 正确。

## 4. 环境速查

- 本机：`cd /Users/wanghanbao/agnes-harness && AGH_HOME=$HOME/agh-home AGNES_PROFILE=local-dev`；
  daemon/web 日志现在固定在 `/tmp/agh-daemon.log`、`/tmp/agh-web.log`（nohup）。
- 发布平台：`cd examples/packages/protein-platform && node tools/build.mjs &&
  AGH_HOME=$HOME/agh-home AGNES_PROFILE=local-dev node --import tsx ../dev-tests/agh-update-platform.mts`
  （本地不带 PP_SURFACE_WS_URL 没关系；服务器必须带）。
- 公网：https://hambobo.tail81da4f.ts.net/platform/（guest 只读闸门已上线）。
- 凭据：任何密码不进聊天；gpw 读取命令模板在本文件 §3 和记忆 agh-server-deploy。
- git：每轮收尾 commit main + push origin（HongboWanggl/Hacker），勿 push upstream；
  末尾 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

## 5. 遗留小项

- funnel 真公网路径 WS 对 h1 客户端挂起（HTTP 正常；tailnet 内正常；浏览器 401→重试 dance 能过）
  ——外部测试者能否连 WS 待真实反馈验证，未修。
- 服务器 caddy 临时 access log（`~/.local/caddy/Caddyfile` 的 `log { output file … }` 块）测试期结束要撤。
- 服务器上 smoke 生成的一份数据库归档被 guest DELETE 事故删掉（无用户数据），跑 smoke 会自然补回。
- Backlog（低优）：归档列表分页；batch 逐目标实时进度；报告墙排序。
