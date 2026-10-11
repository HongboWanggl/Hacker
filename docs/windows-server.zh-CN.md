# 把 Windows 电脑变成蛋白质 Agent 服务器

[English](windows-server.md) | 简体中文
目标：把这台 Windows 机器配置成本项目的**正式服务器**——所有代码和服务统一在它上面跑：
AGH daemon、Web UI、数据目录、密钥文件、（后续）本地 Boltz-2 引擎都部署在这里，
使用者在浏览器打开 `http://<windows-ip>:4177`。

Mac 是**开发机**：只负责改代码、push 到 GitHub；服务器侧 pull + 构建 + 重启即可上线
（见下文「日常部署流程」）。切换完成后，Mac 不再需要常驻跑 daemon。

角色划分：

| 角色 | 机器 | 职责 |
|---|---|---|
| 生产服务器 | Windows 电脑 | daemon + Web UI（0.0.0.0:4177）、数据目录、密钥、本地 Boltz-2（后续）、self-hosted CI runner |
| 开发 | Mac | Claude Code、编辑器、测试；push 到 `origin main` |

## 前置认知：哪些能力迁移后不变，哪些要另配

| 能力 | 迁移后状态 |
|---|---|
| Web UI / daemon / 工具调度 | ✅ 纯 Node.js，跨平台 |
| UniProt 搜索、ESMFold 预测、AlphaFold 对比 | ✅ 都是远程 API，任何能上网的机器都可用 |
| Boltz-2 云端（配 API key） | ✅ 远程 API，可用 |
| Boltz-2 **本地引擎** | ⚠️ 需在服务器上单独装 Python + CUDA 版 torch + ~10 GB 权重；迁移期重型复合物任务先留在 Mac 上跑，稳定后迁过来（或配 key 走云端） |
| Ark 模型路由 | ✅ 配置文件 + key 迁移即可 |

## 第 1 步：装基础环境（PowerShell 管理员）

```powershell
# Node.js LTS（要求 >= 24.10）与 Git
winget install OpenJS.NodeJS.LTS
winget install Git.Git
# pnpm（仓库用 pnpm@10）
corepack enable
```

## 第 2 步：取代码

仓库是私有的（`HongboWanggl/Hacker`），二选一：

```powershell
# 方式 A：GitHub CLI 登录后克隆
winget install GitHub.cli
gh auth login
git clone https://github.com/HongboWanggl/Hacker.git C:\agnes-harness

# 方式 B：U 盘 / 局域网直接从 Mac 拷贝整个目录（含 node_modules 可省一次安装）
```

## 第 3 步：安装依赖 + 构建

```powershell
cd C:\agnes-harness
pnpm install
pnpm typecheck   # 验证；daemon 需要构建产物 packages/cli/dist
pnpm --filter @agnes/cli build   # 若 dist 不在 git 里，用此命令构建
```

## 第 4 步：数据目录与密钥（不要走聊天/截图传 key）

```powershell
mkdir C:\agh-home\data, C:\agh-home\secrets -Force
```

从 Mac 拷贝（U 盘或 `scp`，**文件内容不要打印出来**）：

| Mac 位置 | 拷到 Windows |
|---|---|
| `~/agh-home/profiles/local-dev/profile.yaml` | `C:\agh-home\profiles\local-dev\profile.yaml`（含 Ark 路由配置） |
| `~/agh-home/data/secrets/agnes-ai/default` | `C:\agh-home\data\secrets\agnes-ai\default` |
| `~/agh-home/secrets/boltz/default`（如有） | `C:\agh-home\secrets\boltz\default` |

> 异地不方便 scp/U 盘时：先把文件拷到对方**桌面**（向日葵文件传送或聊天工具传文件均可），
> 再由部署步骤移入 `C:\agh-home` 并收紧权限。**任何情况下密钥文件内容不要粘贴进聊天、
> 截图或 git 仓库**——传「文件」而不是传「文字」。

拷完在 PowerShell 里收紧权限（NTFS）：
```powershell
icacls C:\agh-home\data\secrets /inheritance:r /grant:r "$env:USERNAME:R"
icacls C:\agh-home\secrets /inheritance:r /grant:r "$env:USERNAME:R"
```

## 第 5 步：启动 daemon（绑到局域网）

关键区别：Mac 上绑的是 `127.0.0.1`，服务器要绑 `0.0.0.0`：

```powershell
$env:AGH_HOME = "C:\agh-home"
$env:AGNES_PROFILE = "local-dev"
node C:\agnes-harness\packages\cli\dist\local\daemon.mjs `
  --profile local-dev `
  --workspace C:\agnes-harness `
  --data-dir C:\agh-home\data `
  --local-web-addr 0.0.0.0:4177 `
  --local-web-origin http://<局域网IP或域名>:4177
```

> 先在本机验证：浏览器开 `http://localhost:4177`；成功后再对外。

## 第 6 步：防火墙放行 + 开机自启 + 不休眠

```powershell
# 防火墙放行 4177（仅局域网_profile 可按需收紧为 -RemoteAddress LocalSubnet）
New-NetFirewallRule -DisplayName "AGH Web 4177" -Direction Inbound -Protocol TCP -LocalPort 4177 -Action Allow

# 开机自启（Task Scheduler，登录时拉起）
schtasks /Create /TN "AGH daemon" /SC ONLOGON /TR ^
  "cmd /c set AGH_HOME=C:\agh-home&& set AGNES_PROFILE=local-dev&& node C:\agnes-harness\packages\cli\dist\local\daemon.mjs --profile local-dev --workspace C:\agnes-harness --data-dir C:\agh-home\data --local-web-addr 0.0.0.0:4177 --local-web-origin http://<IP>:4177" /F

# 禁止睡眠（服务器必须常醒）
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

## 第 7 步：别人怎么访问

| 对方在哪 | 方案 |
|---|---|
| 同一局域网 | 直接开 `http://<windows-ip>:4177` |
| 异地 | 两边都装 **Tailscale**（免费）登同一账号，访问 `http://<tailscale-ip>:4177`——加密且自带鉴权，不暴露公网 |

### 异地部署流程（不在同一局域网时）

代码与文档走 GitHub，密钥走人工点对点，部署交给对面机器上的 Claude Code：

1. **GitHub 传代码**：本仓库（`HongboWanggl/Hacker`）已含本文档；对面 `git clone` 即得全部代码与 `docs/windows-server.md`。
2. **密钥人工传**：Mac 上把第 4 步表格里的 2–3 个文件拷到对方**桌面**（向日葵文件传送等），不要走 git。
3. **Tailscale 组网**：两边都装 Tailscale、登同一账号；Windows 上 `ipconfig` 记下 `100.x.x.x` 的 Tailscale IP。此后所有访问都走这个 IP，向日葵只留作应急/传文件。
4. **对面跑 Claude Code** 执行部署（提示词见下），装依赖、移密钥入 `C:\agh-home`、收紧 NTFS 权限、配防火墙与自启。
5. **防火墙**：用了 Tailscale 后，防火墙规则可直接限定 Tailscale 网段（更干净）：
   ```powershell
   New-NetFirewallRule -DisplayName "AGH Web 4177 (Tailscale)" -Direction Inbound -Protocol TCP -LocalPort 4177 -Action Allow -RemoteAddress 100.64.0.0/10
   ```
   向日葵建议平时退出登录，用时再上，减少暴露面。

查本机局域网 IP：`ipconfig`（找 IPv4 地址）。

## 日常部署流程（Mac push 之后）

服务器是唯一运行环境。Mac 上每次开发出新的 `origin main` 提交后，在服务器上更新：

```powershell
cd C:\agnes-harness
git pull origin main
pnpm install                       # 依赖有变动时才需要
pnpm --filter @agnes/cli build     # 重新构建 packages/cli/dist
# 重启：先停掉正在跑的 daemon（任务计划程序结束 / kill node 进程），
# 再按第 5 步原样启动
```

停启检查清单：

1. 停掉旧 daemon 进程（若 Web 是独立进程也要停）；恢复前页面会显示"等待后端恢复"。
2. 按第 5 步命令重新启动 daemon（环境变量与参数不变）。
3. 刷新 `http://localhost:4177`，跑一条冒烟请求确认正常，再通知他人新版本已上线。

可选便利——存为 `C:\agnes-harness\deploy.ps1`：

```powershell
git pull origin main
if ($LASTEXITCODE -ne 0) { exit 1 }
pnpm install
pnpm --filter @agnes/cli build
Get-Process node -ErrorAction SilentlyContinue | Where-Object {
  $_.MainWindowTitle -eq '' } | Stop-Process -Force   # 按实际进程布局调整
schtasks /Run /TN "AGH daemon"
Write-Host "Deployed. Verify http://localhost:4177"
```

> 上面的 `Stop-Process` 是刻意从简的写法；如果服务器上还跑着其他 Node 程序，
> 请改为只杀 AGH daemon 的 PID。

## 在服务器上跑 CI（self-hosted runner）

仓库的 GitHub Actions 免费分钟数已用完，云端 CI 不再执行。服务器稳定运行后，
把它注册为仓库的 **self-hosted runner**（仓库 Settings → Actions → Runners →
New self-hosted runner），此后每次 push 到 `main` 都会在服务器上构建测试，
Mac 侧开发也重新有了真实的 CI 反馈。

## ⚠️ 安全须知（重要）

1. **Web UI 没有登录鉴权**：能打开页面 = 能跑工具、烧 API 额度、读工作区文件。
   - 局域网部署：至少把防火墙规则限定 `LocalSubnet`
   - 对公网/异地：**务必**走 Tailscale，或在前面加反代（nginx/caddy + Basic Auth）
2. API key 只存文件（0600/NTFS 收紧），不进聊天、不进截图、不进 git。
3. 首次部署后跑一遍冒烟测试（见下）再给他人地址。

## 冒烟测试清单

- [ ] 本机 `http://localhost:4177` 打开
- [ ] 另一台设备 `http://<windows-ip>:4177` 打开
- [ ] 在 protein-predictor 工作区发一句 `预测 P61626 的结构并分析置信度`，面板正常渲染
- [ ] 批处理/复合物各试一单，确认 Ark 路由与外部 API 通
- [ ] 重启 Windows 后 daemon 自动拉起、页面可访问

## 已知风险 / 待验证

- AGH 在 Windows 上没有长期运行记录，路径分隔符/信号处理可能有坑——冒烟测试通过再交付使用。
- 本地 Boltz-2（CUDA）是独立的安装工程，确认稳定运行后再迁。
- Mac 这边的本地权重与密钥在迁移完成前保持不动，两边可并行。
