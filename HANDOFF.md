# 交接文档：蛋白质平台迭代（2026-10-14）

> 状态：**第 25 轮欠账清零——predictor kabsch 退化修复 + 归档服务端落盘上线公网，真测全绿（2026-10-14，第 26 轮）**——
> 归档不再依赖浏览器在线：客户端只提交一份工作区相对路径，服务端自行读取 `<tasksRoot>/<taskId>/` 落盘。

## 追加完成项（第 26 轮：把欠的帐处理掉）

1. **predictor kabsch 退化**（protein-predictor/alphafold.mjs）：幂迭代 `dominantQuaternion` 换成
   cyclic Jacobi；近共面/共线点云 RMSD 由 6.989 → 0（pairwise-unit 覆盖两类退化）。
2. **归档静默丢失**（约一半 bench-loop 运行丢归档）：根因是旧流程把产物 base64 经 2–4 次在线 BFF
   调用搬运，窗口长达数秒，页面跳转即中断。现在客户端 `archiveTask` 单次 POST 工作区相对路径
   （body < 60000 字符才 `keepalive`），服务端 `putArchive` 自行从工作区拉取：
   - 绝对 savedTo 归一化 + 路径穿越守卫；超预算只丢 `pdb-*`（最大者先丢），report.json 必保留；
   - 元数据不变量：`reportPath` 仅在 report.json 真正落盘时写入，`pdbPath` 仅在 model.pdb 存在时写入；
   - PAE 写入时量化、缩略图写入时预算、meanPlddt/verdict 从报告回填。
3. **代码整理**：NPZ/NPY 读取抽到 `protein-view/extensions/main/npz-parse.mjs`，由 protein.pae 服务与
   平台归档共用，输出形状不再漂移。
4. **验证**：`dev-tests/archive-put.mts` 13 断言全绿（单体/穿越/批量/超预算/绝对路径）；typecheck 干净，
   改动文件 biome 0 error。`boltz-flow-unit.mts` 的既有失败（`calls[0].init` undefined）也已修：
   根因是算力路由第一档 `runWorkerBoltz` 用**全局 fetch** 探测 `BOLTZ_WORKER_URL`（默认 127.0.0.1:7610），
   排在 API 分支之前且不受测试的 tctx.net mock 管——开发机上有活的 worker 隧道时，单测会**静默跑真 GPU
   预测**然后整条 API 断言全空。修法：测试在 import boltz.mjs 前把 `BOLTZ_WORKER_URL` 钉到死端口
   （模块级 const 在加载时取值，须先设 env 再动态 import）；连接拒绝是瞬时的，顺带真实覆盖了
   「worker 失败→落回原链路」的分发语义。全部断言 PASS，exit 0。
5. **部署**：VPS 仓库 5a2cc277 → 3d648c50（thin bundle，base 必须是 VPS 实际 HEAD）；
   `agh-update-platform.mts` 重新发布（integrity sha256-5c5d1ba83e7309491，安装 dist 含新特性串）；
   daemon + web 双重启，公网 302 登录门正常。
6. **公网真测（凭据经 env，未落盘未打印）**：pp-platform-live PASS、首页渲染诊断干净、
   pp-archive-roundtrip PASS（reportPath/pdbPath/meanPlddt/verdict/缩略图齐全，纯归档重建 OK）、
   pp-batch-smoke PASS、pp-compare-smoke PASS（refSavedTo 分支落盘）。
7. **未做（可选）**：欠账 #3 T1024（408aa 膜蛋白）确定性失败的根因排查未开始，仍诚实显示「待运行」。
8. **文档**：操作手册 §4 放宽「关页面」提示（归档已服务端完成），版本升至 2026-10-14。

## 追加完成项（第 25 轮：平台基准化 · CASP14）

1. **打分数学**（server/src/lddt.ts，纯函数零依赖）：
   - NW 全局比对（match +2/mismatch −1/gap −2，Int32Array 行主序 DP）→ 共享残基对；
   - **Cα-lDDT**（Mariani et al. 2013，CASP/CAMEO 口径）：参考 15 Å 包含半径内距离对在
     0.5/1/2/4 Å 四阈值下的保留比例均值；平台全链 Cα/B-factor 基，故为 Cα-lDDT，UI 已披露；
   - **CA-RMSD**：Horn 四元数最优叠合。**坑**：predictor 的幂迭代 kabsch 在近共面/共线点云上
     λ1≈|λ4| 退化（200 轮留混合向量，测试螺旋链 rmsd 0.976）；bench 侧改用**循环 Jacobi 4×4
     特征向量**求主特征向量（50 sweep 零最大非对角元 + acc 累积旋转）。⚠️ 生产
     protein-predictor/alphafold.mjs 的 kabsch 仍是幂迭代、同样的潜在退化**未修**（本轮不扩散
     战线），留待后续轮次。
2. **基准数据**（server/bench/，随 build 进 dist/bench）：CASP14 十靶标 manifest（targets.json，
   65–408 aa 升序）+ 十个 RCSB 参考结构（T*.pdb， curator 时经 NW 裁剪到同一性匹配残基、
   逐靶 REMARK 记来源；巨链 cryo-EM 要先按链序取连续残基 run 再过滤，否则残基号撞车）。
   序列来自 predictioncenter.org 官方 CASP14 seq 文件（WebFetch 被域验证挡，curl 直下）。
3. **打分服务**（server/src/bench.ts + main.ts `GET api/bench`）：
   - 归档标题契约：runner 提交 FASTA 时 `.pl-input-name = CASP14-<id>` → 归档 meta.title 带前缀，
     服务端按 `CASP14-<id>` 前缀匹配、savedAt 最新者胜（重提覆盖旧attempt）；
   - 打分按需 + memoize（taskId → 结果）；392 残基打分 ~7ms；
   - **归档写盘静默丢失回退**：客户端归档是 best-effort（bffCall 需会话仍在 daemon 注册表），
     提交循环下 ~半数运行归档失败（未根因，疑似会话注册表逐出竞态）→ bench.ts 加
     findWorkspaceArtifacts 回退：扫 `PROTEIN_PLATFORM_TASKS_ROOT ?? $AGH_HOME/protein-platform/tasks`
     下 `CASP14-<id>_*.json/.pdb`，报告 mtime 最新者胜。**勿删这条回退，公网/批量跑分靠它。**
4. **基准页**（client/src/views/bench.tsx，#/bench，导航「基准」）：分数表（靶标/名称/RCSB
   深链/残基/平均 pLDDT/Cα-lDDT 带/Cα-RMSD）+ pLDDT 校准 SVG（十桶柱 + 虚线理想对角）；
   配色沿用 AF pLDDT 色带（b-hi/b-ok/b-lo/b-bad）；待运行行诚实显示。
5. **探针**：
   - pp-lddt-unit.mts：22 断言纯数学（NW 恒等/缺残基/悬空、identity lddt=1、**刚体运动不变性**、
     噪声单调退化、局部 20 残基位移在 per-residue 显形、gappy 比对、<5 对拒打分、乱坐标塌缩）；
   - pp-bench-page.mjs：route 注入 api/bench（2 done + 1 pending），锁表格/pill/PDB 链接/校准 SVG/导航；
   - pp-bench-run.mjs：可续跑提交器——先拉 api/bench 组 doneIds 跳过已打分靶标，逐靶 composer
     提交（30 min 天花板），终局 scoreboard 打印。重跑实测幂等（9 skip + T1024 重试仍失败）。
6. **真跑结果**（家里 4060，小靶标 1–2 min/个，全部走真实管线）：
   | 靶标 | 长度 | Cα-lDDT | CA-RMSD |
   |---|---|---|---|
   | T1025 | 93 | **0.952** | 0.65 Å |
   | T1030 | 103 | 0.943 | 2.82 Å |
   | T1046s2 | 108 | 0.859 | 1.71 Å |
   | T1056 | 125 | 0.817 | 3.36 Å |
   | T1027 | 284 | 0.518 | 14.52 Å |
   | T1029 | 125 | 0.472 | 10.91 Å |
   | T1038 | 238 | 0.409 | 14.54 Å |
   | T1049 | 141 | 0.311 | 15.39 Å |
   | T1064 | 106 | 0.291 | 14.08 Å |
   T1024（408aa 膜蛋白 LmrP）本地**确定性失败**（含第 23 轮自动重试，工作区零产物）→ 诚实「待运行」。
   **pLDDT 校准近理想**：90→0.955、80→0.873、70→0.752、30→0.307——模型置信度诚实，低置信靶标
   真的错误折叠；这是比单看 lDDT 更有说服力的数据点。
7. **验证**：typecheck 干净、新文件 biome 干净；lddt-unit/bench-page/archive-paginate/
   help-smoke/archive-roundtrip/switch-page PASS；**部署**：bundle ff → 5a2cc27，VPS republish
   （integrity sha256-07591e9416afbf9d4，脚本自带 build，dist/bench 随包）+ daemon/web 双重启；
   公网 bench-page PASS + help-smoke/paginate 回归 PASS。公网 api/bench 0/10 属实（公网站点
   未跑过 CASP14，全部诚实显示待运行——要在公网出分需在公网跑 pp-bench-run，但 VPS 无 GPU，
   ESMFold 链路慢，未执行）。

## 追加完成项（第 24 轮：归档列表分页）

1. **客户端窗口分页**（63f0842）：listArchive 仍取全量——服务端 meta 惰性回填已有
   write-back 缓存，开销在 DOM 不在取数；且任务页的类型 chips/搜索/计数都建立在
   全量列表上，服务端分页会破坏计数语义。historyF 渲染窗口 30 条，「加载更多 ·
   还有 N 条」每次 +30；filter/q 变化窗口复位。报告墙保持 12 条 cap 预览不变。
2. **探针 pp-archive-paginate**：playwright route 拦截 GET api/archive 注入 45 条合成
   归档（每条带预计算 thumb → StructureThumb 零请求），断言 窗口=30/最新序/还有 15 条/
   chip 计数=45（全量非窗口）/展开=45 且按钮消失/搜索复位窗口。无需真实归档数据，
   空档新站可跑。本机+公网 PASS；回归 pp-tasks-filter/pp-wall-sort/
   pp-archive-roundtrip/pp-guest-gate 全绿。
3. **部署**：bundle ff → 63f0842，VPS republish（integrity 69597938）+ daemon/web
   双重启；公网探针 paginate/help-smoke/tasks-filter/switch-page PASS。
   纯客户端资产改动 republish 后立即生效（web 直接服务 deployment 静态文件，
   ?v=hash 换新即拉新，无需重启——本轮实测，重启只是保险）。
4. **探针教训（重犯提示）**：公网跑任何 pp-* 探针都必须带 PP_USER/PP_PASS——漏带
   匿名被登录门 302 到 /login，探针在等 .pl-taskrow 超时，表现为「页面空白」假象
   （第 23 轮登录字段坑之后本轮又踩了一次漏带凭据）。

## 追加完成项（第 23 轮：瞬时失败自动重试）

1. **transient.ts（新，client/src）**：`isTransientError()` 单一判据。覆盖网关/传输类
   （STALL_WATCHDOG、TRANSPORT、事件流中断、ECONN/EAI_AGAIN/EPIPE、socket hang up、
   fetch failed）+ 服务类（HTTP 5xx/429、rate limit、overloaded、E_SERVICE、busy、
   task dir: HTTP 5）。**显式不匹配**：通用 timeout/timed out（boltz 20min 工具超时是
   确定性失败，重试白烧 20 分钟 GPU；网关挂起由 STALL_WATCHDOG 自己的标记覆盖）、
   401/403、会话不存在。
2. **orchestrator 重试循环**：原「仅 1 次重试 + 只认网关错误」升级为最多 2 次重试
   （退避 3s → 8s），每次全新 session。重试门四条：failed + **无任何产出**
   （savedTo/resultJson 全空）+ 非用户取消 + 判据命中。**有产出的失败不自动重试**
   ——部分结果 + 手动 ↻ 优于抹掉已产出的 PDB 重跑同一预测。假完成分支（completed+
   零产出+lastError）的 tool 层瞬时错误（API 5xx/限流/worker busy）首次被覆盖——
   第 21/22 轮的「瞬时故障」正是这一类，此前只有网关层错误才重试。
3. **验证**：`pp-transient-unit.mts` 37 断言全过（含反例：boltz 超时/403/序列非法
   不重试）；新探针 `pp-auto-retry.mjs` 用 playwright route 拦截把首次 POST api/task
   打成 503 → 断言恰好 2 次尝试 + 最终已完成 + canvas 出图。**探针竞态教训**：失败
   徽章在 3s 退避期就出现，必须先等第 2 次 api/task post 再断言最终态（首版读早了
   假 FAIL，重试实际成功了）。本机回归 pp-help-smoke/pp-cancel-smoke（取消不被重试）/
   pp-retry-smoke/pp-platform-live 全 PASS。
4. **部署**：bundle 同步 489c599→03dc5998 到 VPS，agh-update-platform（integrity
   ed4a7753 与本地一致）+ daemon/web 双重启。公网探针 pp-auto-retry / pp-switch-page /
   pp-nl-search / pp-help-smoke / pp-guest-gate（guest 身份）全 PASS。
5. **登录调试踩坑（记入记忆）**：POST /login 表单字段是 `user` 不是 `username`（错字段
   名 = 200 重发登录页，看似密码错）；caddy-credentials.txt 格式 `账号: 密码` 冒号后
   有空格，cut -d: -f2- 要再 sed 掉前导空格。另：Caddy basic_auth 密码与 users.json
   scrypt 哈希已核对一致，密码本身没错。

## 追加完成项（第 22 轮：切页恢复 + 内联结构 + 自然语言输入）

1. **切页/刷新不再打断预测**（commit 0224ac4）：根因是刷新后 orchestrator 不会重新挂到
   运行中的 session——attach() 在监听器建立前就回放完了事件。修法：`reattachRunningTasks(sdk)`
   在 boot 时对每个运行中任务走 `sdk.session.load()`（load 内部会 attach，回放行能到达监听器）；
   事件归约抽成 `reduceLedgerEvent`（live 循环与 reattach 共用，消除双份漂移）；journal 耗尽
   无 turn/end → failed；load 失败 → failed 带错误文本。
2. **内联报告也能渲染结构**（同 commit）：predict_structure 的报告有时不落 savedTo（内联
   JSON），此前结果页空态。现 orchestrator 在文本含 `"sequenceLength"` 时捕获 resultJson；
   result.tsx 在无 savedTo 时用 `preview={task.resultJson}` 渲染 ToolViewStage；archiveTask
   对 single/complex 缺 resultSavedTo 时回退 resultJson。
3. **自然语言输入**（commit 11b77a4）：composer.ts 新增 `classifySingle`（fasta/accession/
   sequence/short/junk/description 六分类，20-aa 字母表正则是核心判据），inspect 条与提交
   路径共用同一分类器不会漂移。description → `search` 任务 → SearchCard 候选列表 →
   每行 ▶ 一键预测（即确认步骤）。search prompt 把用户原话嵌进 prompt（否则 agent 反问
   用户导致空转）。英文盲区：全由 AA 字母组成的英文词会读成过短序列——inspect 条会
   显示该解读，用户可改述。
4. **验证**：本地 pp-switch-page（提交→中途 reload→必须已完成+canvas）、pp-nl-search
   （chip=自然语言→search 已完成→候选▶→预测已完成→canvas）全 PASS；公网 dbg 探针
   全绿（savedTo 三件套齐、canvas rendered）。
5. **NL 候选预测「失败」复诊**：首次公网跑出现 失败但 PDB 已产出、刷新后 canvas 又渲染
   ——复跑同一流程全绿。结论：瞬时故障类别（与第 21 轮 complex 偶发失败同类），结果页
   「↻ 重新提交」兜底即可，不改码。
6. **部署**：VPS thin bundle ff 到 11b77a4（前置 551c94bf），agh-update-platform 重发 +
   daemon/web 双重启。SSH 偶发 connection reset（重试即愈，与本轮改动无关）。
7. **新探针**：`pp-switch-page.mjs`、`pp-nl-search.mjs`（公网可用：PP_BASE/PP_USER/PP_PASS）。


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
