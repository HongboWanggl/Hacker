# 交接文档：蛋白质平台迭代（2026-10-13）

> 状态：**算力路由二期 + 夜班三修全量上线（2026-10-13 深夜，第 21 轮）**——VPS 分发链
> 头插 GPU worker 档（探活 1.5s → 22min 上限 → 任何失败静默落回原链）；「没有可展示
> 的结果」双根因修复（VPS 无算力 + 假完成语义）；复制三按钮 http 兜底（execCommand +
> 下载）。全链路真测绿，公网站点可直接验收。用户指示：夜班自治，明早验收。

## 追加完成项（第 21 轮：算力路由二期 + 复合物结果 + 复制按钮）

1. **算力路由二期**（用户拍板开工）：`boltz.mjs` 分发链 = **worker → 云 API → 本地 CLI →
   SETUP_HINT**。`runWorkerBoltz`：探 `127.0.0.1:7610/health`（1.5s 超时，隧道断零成本）→
   POST /predict（22min 上限 > worker 自身 20min 任务上限）→ 任何失败返回 undefined 落回
   原链。报告整形抽成 `finishBoltzResult`（worker/本地两路共用；engine 区分
   boltz2-worker/boltz2-local）。token 在 VPS `~/.config/boltz-worker/token`（家里 scp 而来，
   不进聊天）。
2. **真实测试**：公网 UI 提交双链复合物 → 家里 RTX 4060 跑 ~3 分钟 → 报告
   `engine:"boltz2-worker"`、ptm 70.5/iptm 58.4、PAE 落盘、归档回放全绿（pp-complex-full
   PASS×2）。**fallback 真测**：停隧道 → 提交 → 秒级 failed + 可执行的 SETUP_HINT 提示，
   不再假完成；隧道拉起 → 恢复 GPU 跑通。
3. **「没有可展示的结果」双根因**（用户报的第二项）：
   - **算力根因**：VPS 无 BOLTZ_API_KEY 无本地 boltz → predict_complex 必然 fail(SETUP_HINT)
     ——二期路由顺带根治（worker 档兜住正常预测）。
   - **假完成根因**：agent 把工具错误当数据报告后正常收尾 → 平台一律标「已完成」→ 结果页
     「没有可展示的结果」无解释、任务墙绿勾。修 orchestrator：completed + 无 resultJson +
     无 savedTo + lastError → **failed + 带出错误文本**；归档仅在真 done 时触发。
   - 顺带修：复合物报告匹配器补 `"boltz2-worker"`（orchestrator.ts）。
4. **复制三按钮**（用户报的第三项）：`navigator.clipboard` 仅 secure context 存在，http 裸
   IP 站点上 undefined → 复制静默无效/假成功。修 protein-view client：新增 `copyText`
   （execCommand 兜底，Promise<boolean>）、`copyCanvasPng` 三态（copied/downloaded/failed，
   图像兜底下载 protein-view.png），9 处调用点状态如实反映成败。探针 pp-copy-buttons
   PASS（execCommand ok:true×2 + 真下载事件）。
5. **新探针**：`pp-copy-buttons.mjs`（http 兜底契约；标签断言为 best-effort——toolview 重挂载
   会吞掉 1.6s 的标签闪烁，功能断言才是硬性的）。
6. **部署纪要**：thin bundle 恢复可用（VPS 已有 9c6ce8f 前置）；**agh-update-platform 前必须
   先 commit+sync**（两次踩到「integrity 没变=发布的是旧码」）；publish 后 daemon+web 双重启。
7. **本地回环回归**：platform 重发 + 双重启 → pp-guest-gate / pp-help-smoke /
   pp-copy-buttons / pp-platform-live 全 PASS。
8. **已知边界**：pae 探针行偶发 null（归档写入竞态，信息性输出非断言）；复制图像合成图
   构建 ~3s（大画布 PNG 编码）；runtimeSec 修复已随 991ffdc 发布。

## 追加完成项（第 20 轮：算力路由第一期——GPU worker + 隧道）

1. **动机**（用户提议）：轻量 VPS 够用但无 GPU；家里 WSL 机器配置更好（RTX 4060 Laptop，
   WSL2 GPU 直通正常）。用户拍板：家里机器当第一算力选择、VPS 保底，**先只动家里那台**。
2. **实现**（commit 18884c1 + f0b819f）：
   - `protein-predictor/worker.mjs`（新）：HTTP 包壳复用 `runLocalBoltz`（boltz.mjs 仅补
     一处 `export`，逻辑零改动）。`GET /health`→{ok,busy,bin}，`POST /predict`
     {proteins,smiles?}→{pdb,paeNpzB64,conf,aff}。GPU 串行队列（一次一任务）、请求体
     64KB/响应 32MB 上限、token 校验（`~/.config/boltz-worker/token` 或
     BOLTZ_WORKER_TOKEN，不设则关）。双端只绑 127.0.0.1，公网摸不到。
   - 家里机器（serverofWHB@100.91.157.78，ssh 要 `-i ~/.ssh/agh_key`，默认 key 不认）：
     systemd user 单元 `boltz-worker.service`（跑 repo 里的 worker.mjs）+
     `boltz-tunnel.service`（`ssh -N -R 127.0.0.1:7610:...` 反向隧道，ServerAlive
     30s×3，断线 10s 重连，ExitOnForwardFailure），均 enable+active。
   - 隧道密钥 `~/.ssh/boltz_tunnel`（家里生成）；公钥已加到 VPS authorized_keys
     （**对 VPS 的唯一改动**）。
   - 家里 repo 已 ff 到 f0b819f（GitHub 直连可用，与 VPS 不同）。
3. **验证**：worker 本机冒烟（health/参数校验）；家里 health OK；**VPS 上
   `curl 127.0.0.1:7610/health` 通**（隧道端到端）；真任务：双链 20+20 aa 从 VPS 发起，
   184s 返回 200，334 行 ATOM + PAE npz + conf/aff 齐全（ptm 低是测试序列本身是垃圾
   序列，链路无关）。
4. **第二期（待用户点头）**：VPS `boltz.mjs` 分发链头插一档——探 worker /health（短超时）
   → 通则 POST /predict（带 token），任何失败原样落回现有链（API key → 本地 → SETUP_HINT）。
   预计半天内。token 从家里 `~/.config/boltz-worker/token` 读入 env，不进聊天。
5. **注意事项**：家里机器关机/休眠 = GPU 档自动消失（隧道断，将来二期 fallback 兜底），
   现状下 VPS 行为完全不变；boltz 单任务上限 20 分钟（runLocalBoltz 内置，组 SIGKILL 防
   GPU 孤儿）。

## 追加完成项（第 19 轮：正式登录页 + guest 可提交不可删）

1. **动机**（用户实测反馈）：basic-auth 弹窗丑且无法定制；浏览器对 WS 升级请求不重放
   basic-auth 凭据 → Caddy 对 `/agnesd` 再次 401 质询 → 登录框弹不止一次、网关异常、
   「开始预测」点不了。根因是凭证形态（401 challenge）而非权限。
2. **实现**（commit 9c6ce8f）：
   - `packages/web-server/src/session.ts`（新）：scrypt 密码哈希 + HMAC session token +
     cookie 解析，零依赖。凭据源 `AGH_HOME/users.json`（0600，mtime 缓存），签名密钥
     `AGH_HOME/session-secret`（0600 首启自动建；删它=全员登出）。
   - `server.ts`：`/login`（内联 HTML 登录页，暗色适配、CSP 锁死、open-redirect 防护）、
     `POST /login`（拒 cross-site、32KB body 上限、302+Set-Cookie）、`/login/check`
     （200+X-Forwarded-User 或 302→/login?next=…）、`/logout`。cookie `agh_session`
     HttpOnly SameSite=Lax 30d（http 试用无 Secure，上 TLS 后补）。
   - `web-command.ts`：`authHome` 取 `AGH_HOME` 传入。回环直连（无 AGH_HOME）闸门惰性，
     本地 dev 行为不变。
   - VPS `/etc/caddy/Caddyfile`：`basic_auth` → `route { @gated not path /login* /logout;
     forward_auth … }`。**必须删掉默认 handle 里旧的 `header_up X-Forwarded-User
     {http.auth.user.id}`**（basic-auth 时代的空占位符会抹掉身份，全员变 owner）。
   - 权限：平台 server `roleOf()`——owner（hongbo/无头回环）可提交可删；guest 可提交、
     DELETE 403 原样保留；whoami 加 `role`/`canSubmit`。客户端提交路径从未被闸过，改动≈0。
3. **部署踩坑（新）**：
   - agh-update-platform.mts 在服务器上必须 `node --import tsx` 跑（node 原生 strip-types
     不做 `.js`→`.ts` 解析重写，裸 node 报 ERR_MODULE_NOT_FOUND client.js）。
   - **每次 republish 都要带 `PP_SURFACE_WS_URL`**——漏带会把 `ws://127.0.0.1:46119` 打进
     surface 配置，浏览器直连本机端口 ERR_CONNECTION_REFUSED（本轮实测踩中，重发即愈）。
4. **验证**：VPS curl 矩阵全绿（双角色登录/whoami/guest DELETE 403/owner DELETE 200/
   guest 提交 ok/bad-login 错误页/logout 清 cookie/带 cookie WS 101/匿名 WS 302）；
   浏览器探针 pp-guest-gate PASS（UI 登录、无删除钮、403）、pp-help-smoke PASS、
   pp-platform-live E2E PASS（零弹窗）；本地回环三探针 PASS（owner 模式闸门惰性）。
   pp-tasks-filter 仍属空归档不适用（见第 18 轮第 5 条）。
5. **遗留**：无限流（试用可接受）；http 明文无 Secure flag（挂域名上 TLS 后一并补）；
   探针 /tmp 凭据文件已清理。

## 追加完成项（第 18 轮：腾讯云 VPS 直连部署）

1. **迁移动因**：Tailscale Funnel 走 DERP 中继是冷首访 100-180s 的根因（刻意的带宽限制，
   换代码救不了）；用户拍板租云 VPS 直连（腾讯云轻量 2核2G Ubuntu 24.04，南京访问 ~30ms）。
2. **新服务器**（`ssh ubuntu@118.25.194.247`，Mac 公钥已装，sudo 免密）：
   - Node v24.10.0 在 `~/.local/node24`（npmmirror 下载；GitHub 直连被墙，大文件走
     `https://ghfast.top/` 前缀代理或 Mac 中转）、pnpm@10.34.5、Caddy **2.10.2 官方二进制**
     （Ubuntu 24.04 apt 自带 2.6.2 不认 `basic_auth` 指令和 `header_down >` 强替换前缀，
     不能用！）；代码在 `~/agnes-harness`（git bundle 全量初始化，与 main 同步 03321c0）。
   - systemd user 单元 agnes-daemon/agnes-web（模板从 WSL 老服务器抄，去掉
     BOLTZ_LOCAL_BIN——VPS 无 GPU 无 boltz，预测走 ESMFold 公共 API）+ `enable-linger`。
   - `~/agh-home`：data/secrets/{ark,agnes-ai}/default 从老服务器中转（不进聊天）；
     profiles/local-dev/profile.yaml 用老服务器版（与 Mac 版只差一行 slot: primary）。
   - Caddyfile：老配置去掉 TLS 改 `:80`、撤 access log，其余原样（双账号 bcrypt 哈希
     **现造新密码**——老 caddy-credentials.txt 已陈旧，hongbo/guest 全对不上，别再考古）。
3. **发布**：protein-platform（install 模式，`PP_SURFACE_WS_URL=ws://118.25.194.247/agnesd`，
   注意新站无证书是 **ws:// 不是 wss://**）+ protein-predictor + protein-view 全部
   install→trust→enable 绿。
4. **踩坑记录**：
   - agh-update-pkg.mts 写死 update → 首装必炸 E_DEP_MISSING；已修成 install/update 自适应
     （03321c0，实战验证）。
   - web 首启在 publish 之前 → surface 不挂载 /platform 404；**daemon+web 一起重启**即愈
     （web 启动时要靠 daemon 报 surface）。
   - Mac 的 awk 不认 `\s`（-F':\\s*' 静默失配）——解析凭据用 cut+sed 别用 awk -F。
5. **验证**：公网 index/app.js(immutable)/config.json(wsUrl 钉对)/WS `/agnesd` 101 全过；
   pp-help-smoke PASS、pp-platform-live E2E PASS（真预测+归档落盘）。pp-tasks-filter 在
   **空归档**新站上不适用（.pl-filters 只在有任务时渲染，探针前置条件问题非 bug）。
6. **已知限制**：http 无 secure context → **SW app-shell 缓存在新站不生效**（sw-register
   会静默失败），但冷链路已快到不需要它；以后挂域名上 HTTPS 自动恢复。老 WSL 服务器仍在
   原 address 服务，没动；正式切流/下线待用户拍板。

## 追加完成项（第 17 轮：批量 3D 页签 + 公网链路提速）

1. **批量任务分享报告带逐目标 3D 页签**（9022e43）：查看器吃 sets 数组，批量报告逐 job 取
   structure（≤8，live/archived 均支持），页签显示 accession·均分，切换重绘。新探针
   pp-share-batch.mjs（本机+公网 PASS）。
2. **公网链路提速（本次核心）**——慢的根因：tailscale funnel 走 DERP relay（~10-20KB/s），
   且 Chromium 不复用带 Authorization 响应的盘存缓存 → 每次访问全量重拉 205KB gzip（100-180s）。
   三层修复：
   - 构建钉内容哈希 `?v=<sha256-10>`（ebf2488）+ 服务器 Caddy 对三个静态资产发
     `immutable`（`header_down >Cache-Control` 的 `>` 强替换前缀是关键；`route`/裸 `header`
     都改不动上游头）；
   - **SW app-shell 缓存**（b41ad26 + a5d2cdb）：sw.js 只回缓存**永不发网络请求**——SW 内
     fetch 会丢 basic-auth 凭据（401 且会把 profile 凭据状态标坏：ERR_INVALID_AUTH_CREDENTIALS
     持久化，踩过）；资产 blob 由页面（带凭据）postMessage 递给 SW 存。URL 带 ?v=hash，
     新部署=新 URL=自然失效；sw.js 拦截范围=「页面告知过的 URL」，未知资产走正常鉴权路径。
   - **sw-register.js 必须是外部文件**：页面 CSP `script-src 'self'` 会静默拦截内联
     `<script>`（曾内联注册导致公网 SW 从未激活，排查半天）；且 build.mjs 曾漏拷
     sw-register.js（404）——两坑均已修。
   - 实测：首次访问 16s（填充），重复访问 **5s 整页就绪、app.js/app.css transfer:0
     cache-storage**（此前 100-180s）。
3. 验证：远端 pp-tasks-filter / pp-guest-gate / pp-share-report + 本机 help/share-batch/
   tasks-filter 全 PASS。
4. 收尾小改（66d06a5）：sw-register.js 也钉 ?v=hash + 进 Caddy immutable 名单（省掉每次
   访问 ~541ms 白拉）；index.html 资产改写锚定 src=/href= 属性（防注释误匹配）。公网
   immutable 头验证 + help/tasks-filter 远端回归 PASS。
5. **重复访问耗时分解（优化后实测）**：整页 4.6s = 文档+资产 1.5s（资产全 cache 命中
   transfer:0）+ config.json/api-archive/sw-register 各 ~0.5s + WS 建连与渲染 ~2s。
   剩余优化空间很小；WS 建连无法缓存，冷首访受 DERP relay 带宽限制（换直连部署才能根治）。

**当前状态：链路优化已收束，任务暂停等用户指令。**

**链路优化候选（下轮可做）**：index.html no-store + config.json 每次往返是剩余大头；可考虑
SW 对 config.json 做 stale-while-revalidate（URL 不带 hash，需小心）；public 冷首访仍受
DERP relay 带宽限制（无解，除非换直连部署）。

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
- 公网：`http://118.25.194.247/platform/`（表单登录页，hongbo=owner 可删，guest=可提交不可删；
  老 funnel 地址已不走）。发布平台服务器版：`PP_SURFACE_WS_URL=ws://118.25.194.247/agnesd
  node --import tsx examples/packages/dev-tests/agh-update-platform.mts`（AGH_HOME/AGNES_PROFILE
  指向服务器，daemon+web 一起重启）。
- 凭据：任何密码不进聊天；gpw 读取命令模板在本文件 §3 和记忆 agh-server-deploy。
- git：每轮收尾 commit main + push origin（HongboWanggl/Hacker），勿 push upstream；
  末尾 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。

## 5. 遗留小项

- funnel 真公网路径 WS 对 h1 客户端挂起（HTTP 正常；tailnet 内正常；浏览器 401→重试 dance 能过）
  ——外部测试者能否连 WS 待真实反馈验证，未修。
- 服务器 caddy 临时 access log（`~/.local/caddy/Caddyfile` 的 `log { output file … }` 块）测试期结束要撤。
- 服务器上 smoke 生成的一份数据库归档被 guest DELETE 事故删掉（无用户数据），跑 smoke 会自然补回。
- Backlog（低优）：归档列表分页；batch 逐目标实时进度；报告墙排序。
