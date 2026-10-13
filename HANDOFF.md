# 交接文档：BFF 503 / E_PACKAGE_STATE 排查（2026-10-13）

> 给下一个窗口的完整交接。读这份文档 + 记忆库即可接手，不要重做已完成的排除项。

## 0. 任务背景

8 小时蛋白质科研 Agent 产品迭代（examples/packages/protein-platform）。清单优先级 1-5 已全部落地。
用户最后两个问题：①「为什么点击不了开始预测」②「多测试一下前端功能」。

**「开始预测」已修好第一层**：config.json wsUrl 被 republish 抹成 loopback（发布必须带
`PP_SURFACE_WS_URL=wss://hambobo.tail81da4f.ts.net/agnesd`）→ 已重发+重启服务器 daemon，按钮能点了。

**第二层（当前唯一阻塞）**：BFF `POST /api/client-modules/service` 在**本机和服务器都**返回
503 `{"error":"service unavailable"}`（package-admin.ts:280-284 吞掉真实错误）。后果：
任务能跑完（agent WS 链路正常）但页面侧归档写不进去（`archive write failed: protein.report: HTTP 503`），
SearchCard/BatchCard/归档结果页全部退化为 raw preview 兜底。前端功能大测试被它阻塞。

## 1. 排查进度（本轮已完成，勿重做）

### 已排除
- ❌ operations ledger 损坏 → `~/agh-home/data/daemon/package-operations/operations.json` 健康
  （150 completed / 2 failed / 0 pending），`recoveryError`（E_PACKAGE_INTEGRITY）不成立。
- ❌ **deferred-package-activation 假说（我上一窗口的主嫌疑）已排除**：SDK 探针
  `clientModules.list('local-dev')` 返回 row `web:@aghes/protein-view` →
  `phase:"ready"`, `enabled:true`, `packageId:"@aghes/protein-view"`,
  `moduleName:"plugin/58fc8e52cf789e71"`, revision sha256-5e02f40c…。
  phase=ready 意味着 activation.actual() 返回了真实 observation 且 actualIntegrity 匹配 ——
  **绑定是真的**，不是 deferred unavailable。
- ❌ roster 行匹配失败（那会抛 CAPABILITY_DENIED，不是我们看到的 SEMANTIC_REJECTED/E_PACKAGE_STATE）。
- ❌ host/ext-host 层（service-invocation.ts）只产 CAPABILITY_DENIED / INVALID_PARAMS /
  REQUEST_TIMEOUT / INTERNAL_ERROR；activation-barrier.ts 只产 OVERLOADED。都不产 E_PACKAGE_STATE。

### 原始错误形态（SDK unix socket 直探）
```
message: SEMANTIC_REJECTED (-32011)
data: {"reason":"E_PACKAGE_STATE","code":"SEMANTIC_REJECTED"}
```
这个 `{reason: code}` 形状 = `operationError` 风格（handler.ts）或 worker 侧 E_EXT_LOAD→
E_PACKAGE_STATE 映射（packages/package-manager/src/errors.ts:10 有 `E_EXT_LOAD: 'E_PACKAGE_STATE'`）。

### 完整调用链（已追到 worker 边界）
```
package-admin.ts:283 (503 吞错)
→ handler.ts:739 clientModulesCallService（roster 匹配 ✅ 通过）
→ supervisor.ts:2362 clientServiceCall → packageClientServiceCall
→ supervisor.ts:1466 dispatchClientService：
    inspectService(params, credential) 必须 kind==='query'（否则 CAPABILITY_DENIED）
    → callService(params, credential)
→ service-worker.ts:66/76 workerServiceCaller/Inspector → callWorker → pool.acquireSharedWorker
    → link.command('inspectService'/'callService', {callId, sessionKey, call, credential}, 31s)
→ 【业务 worker 进程内】packages/worker-runtime/src/{main,commands,frames,hosted-sessions}.ts
    → host.callService（packages/host/src/host.ts:176）
    → activationBarrier.admit('service') → prepareService → workspaceRuntimes.invocation(sessionId)
    → serviceInvoker（packages/host/src/ext-host/service-invocation.ts:62）
```
**结论：错误产生在业务 worker 进程内、worker-runtime 命令层或 host.assemble 的
`workspaceRuntimes.invocation` / `publicationDispatch`（sessionKey→workspace→扩展运行时解析）。
最可疑：worker 侧扩展加载（E_EXT_LOAD→E_PACKAGE_STATE 映射），例如 worker 持有的 runtime target
与本机 profile lock 在 round-12 pkill 重启后失配。**

## 2. 下一步排查计划（按序）

1. **审计定位**：`grep extension.service-call ~/agh-home/data/audit/daemon.jsonl | tail`。
   serviceInvoker 的 finally 会写审计行。发起一次 bff-probe 后看：
   - 无新审计行 → 死在 worker-runtime 命令层 / workspaceRuntimes.invocation（serviceInvoker 之前）。
   - 有行（outcome=INTERNAL_ERROR 等）→ 死在 serviceInvoker 内部映射。
2. **读 worker-runtime 命令层**：packages/worker-runtime/src/commands.ts 的
   inspectService/callService handler，找 error 序列化与 E_EXT_LOAD/E_PACKAGE_STATE 来源；
   `workspaceRuntimes.invocation` 在 packages/host/src/assemble.ts（grep `invocation(`）。
3. **对照实验**：daemon 刚重启后 BFF 是否立刻 503？还是 worker 起来后恢复？若「重启即坏、
   从不恢复」→ worker 侧 runtime target reconcile 没跑/没绑定（对照 supervisor.ts:1410
   `bindRuntimePins` / 1425 `publishProbedRuntimeTarget` 是否在本次 boot 执行）。
4. **修复后验证**：`node --import tsx packages/sdk/bff-probe.mts`（AGH_HOME=$HOME/agh-home）
   期望 callService 返回 ok（或 CAPABILITY_DENIED 以外的正常结果）+ curl BFF 200。
5. 服务器端同修：改完先本机验证，再 scp+republish（**必须带
   PP_SURFACE_WS_URL=wss://hambobo.tail81da4f.ts.net/agnesd**）+ `systemctl --user restart
   agnes-daemon`（server.mjs/surface 改动必须重启 daemon，血泪教训见记忆）。
6. BFF 修好后执行「多测试一下前端功能」：远端跑全套探针
   （PP_BASE=https://hambobo.tail81da4f.ts.net/platform/ + PP_USER/PP_PASS 经 ssh 读
   /mnt/c/agh-home/caddy-credentials.txt，不打印）：pp-platform-live(本机)、pp-search-smoke、
   pp-complex-full、pp-batch-smoke、pp-compare-smoke、pp-batch-compare-smoke、pp-wall-filter、
   pp-tasks-filter、pp-composer-inspect、pp-cancel-smoke、pp-retry-smoke、pp-share-report、
   pp-archive-roundtrip，输出 PASS/FAIL 矩阵汇报。

## 3. 环境与操作规程（浓缩）

- 本机：`cd /Users/wanghanbao/agnes-harness && AGH_HOME=$HOME/agh-home AGNES_PROFILE=local-dev`。
  发布平台：`cd examples/packages/protein-platform && node tools/build.mjs && AGH_HOME=… 
  AGNES_PROFILE=… node --import tsx ../dev-tests/agh-update-platform.mts`（dev-tests 在
  examples/packages/dev-tests）。改 server.mjs 类代码后：kill daemon+web 两 pid → nohup 重启
  （见记忆 agh-daemon-restart-ritual）。
- 服务器：`ssh -F /dev/null -i ~/.ssh/agh_key -o IdentitiesOnly=yes serverofWHB@100.91.157.78`，
  `export PATH=$HOME/.local/node24/bin:$PATH`；units: agnes-daemon/agnes-web/caddy（Linger=yes）。
- 公网：https://hambobo.tail81da4f.ts.net/platform/（funnel 已验证公开）；guest 只读闸门已上线。
- 凭据纪律：**任何密码/key 不进聊天**；guest 密码经 ssh sed 读入 env（记忆里有现成命令）。
- git：每轮收尾 commit main + push origin（HongboWanggl/Hacker），勿 push upstream；
  末尾 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

## 4. 待办（BFF 之外）

- funnel 真公网路径 WS 对 h1 客户端挂起（HTTP 正常；tailnet 内 node WS 正常）——外部测试者能否连
  WS 待验证，未修。
- 服务器 caddy 临时 access log（`~/.local/caddy/Caddyfile` 的 `log { output file … }` 块）调试完要撤。
- 本探针 `packages/sdk/bff-probe.mts` 是临时件，BFF 修好、验证完删掉。
- 服务器上 smoke 生成的归档被 guest DELETE 事故删掉一份（无用户数据），如需可重跑 smoke 补。
- Backlog（低优）：归档列表分页；batch 逐目标实时进度；报告墙排序。

## 5. 本轮代码改动（未提交的只有探针一行修正）

- packages/sdk/bff-probe.mts：list 调用签名修正（`clientModules.list('local-dev')`，SDK 包装层
  收字符串不是对象）。其余工作已在前几轮 commit（73c98ac / 513c6ba / 2bed1e6 / 8e515fe 等）。
