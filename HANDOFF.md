# 交接文档：蛋白质平台迭代（2026-10-13，BFF 503 已结案）

> 给下一个窗口。上一轮（第 13 轮前半）已把 BFF 503 排查**结案**——结论比预期简单：BFF 从来没坏。

## 0. 一句话现状

产品功能清单 1-5 全部落地；「开始预测」已修（wsUrl 层）；**BFF 503 假回归已结案**（见 §1）；
本地 daemon/web 全新运行且 search smoke E2E PASS。**下一个窗口的主任务是：
「多测试一下前端功能」= 远端全套探针矩阵（§3），外加服务器侧同步两处小改（§2）。**

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

## 2. 服务器侧待同步（远端测试前做）

本机两处改动需要上服务器（WSL，`ssh -F /dev/null -i ~/.ssh/agh_key -o IdentitiesOnly=yes
serverofWHB@100.91.157.78`，`export PATH=$HOME/.local/node24/bin:$PATH`）：

1. **bff.ts 重试**（platform client bundle）：本机 build 平台 → scp `dist/` 到服务器 deploy 目录 →
   republish **必须带 `PP_SURFACE_WS_URL=wss://hambobo.tail81da4f.ts.net/agnesd`**（否则 wsUrl
   被抹成 loopback，提交按钮又灰）→ `systemctl --user restart agnes-daemon`。
2. **package-admin.ts 日志**（launcher）：服务器若从 git 仓库跑，pull 后 rebuild cli dist +
   重启；若只 scp 过 dist，则同样 scp 对应产物。低优先——只是可观测性，不影响功能。

## 3. 主任务：前端功能大测试（用户明确要求）

远端模式跑全套探针（凭据纪律：密码经 ssh 读 `/mnt/c/agh-home/caddy-credentials.txt` 的 guest 行
进 env，**不打印**；探针用 `PP_BASE=https://hambobo.tail81da4f.ts.net/platform/ PP_USER=guest
PP_PASS=$GPW`）：

```
pp-search-smoke  pp-complex-full  pp-batch-smoke  pp-compare-smoke  pp-batch-compare-smoke
pp-cancel-smoke  pp-retry-smoke   pp-share-report  pp-archive-roundtrip
pp-wall-filter   pp-tasks-filter  pp-composer-inspect  pp-thumb-wall --shots
```

本机模式再跑 `pp-platform-live.mjs --shots`（单体全流程）+ `pp-help-smoke`。输出 PASS/FAIL
矩阵汇报。已知 flake：compare smoke 的 "compare button not visible"（重跑即过）；探针要在
关浏览器前等归档落盘。**注意：重启服务器 unit 会打断在跑的远端探针——先同步 §2 再开跑，
跑的过程中不再动服务器。**

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
