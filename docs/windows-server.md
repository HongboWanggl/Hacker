# Turn a Windows PC into the Protein Agent Server

English | [简体中文](windows-server.zh-CN.md)

Goal: run the AGH daemon + Web UI on a Windows machine (GPU, 16 GB RAM) and let
people on the LAN or remote access `http://<windows-ip>:4177` in a browser.

## What carries over unchanged vs. what needs extra setup

| Capability | After migration |
|---|---|
| Web UI / daemon / tool dispatch | ✅ Pure Node.js, cross-platform |
| UniProt search, ESMFold prediction, AlphaFold compare | ✅ All remote APIs; any online machine works |
| Boltz-2 cloud (with API key) | ✅ Remote API, works |
| Boltz-2 **local engine** | ⚠️ Needs a separate Python + CUDA torch install + ~10 GB of weights; on a 16 GB machine it is best to **not migrate it yet** — keep heavy complex jobs on the Mac (or use the cloud API with a key) |
| Ark model routing | ✅ Migrate the config file + key |

## Step 1: Install the base environment (PowerShell as admin)

```powershell
# Node.js LTS (requires >= 24.10) and Git
winget install OpenJS.NodeJS.LTS
winget install Git.Git
# pnpm (the repo uses pnpm@10)
corepack enable
```

## Step 2: Get the code

The repository is private (`HongboWanggl/Hacker`); pick one:

```powershell
# Option A: clone after GitHub CLI login
winget install GitHub.cli
gh auth login
git clone https://github.com/HongboWanggl/Hacker.git C:\agnes-harness

# Option B: copy the whole directory from the Mac via USB stick / LAN
# (including node_modules saves one install pass)
```

## Step 3: Install dependencies + build

```powershell
cd C:\agnes-harness
pnpm install
pnpm typecheck   # sanity check; the daemon needs the built packages/cli/dist
pnpm --filter @agnes/cli build   # if dist is not in git, build with this
```

## Step 4: Data directory and keys (never move keys through chat/screenshots)

```powershell
mkdir C:\agh-home\data, C:\agh-home\secrets -Force
```

Copy from the Mac (USB stick or `scp`; **do not print the file contents**):

| Mac location | Copy to Windows |
|---|---|
| `~/agh-home/profiles/local-dev/profile.yaml` | `C:\agh-home\profiles\local-dev\profile.yaml` (contains the Ark routing config) |
| `~/agh-home/data/secrets/agnes-ai/default` | `C:\agh-home\data\secrets\agnes-ai\default` |
| `~/agh-home/secrets/boltz/default` (if present) | `C:\agh-home\secrets\boltz\default` |

> When the machines are in different places and scp/USB is impractical: first
> copy the files to the other side's **desktop** (Sunflower file transfer or a
> chat app's file transfer both work), then move them into `C:\agh-home` during
> deployment and tighten permissions. **Never paste secret file contents into
> chat, screenshots, or a git repository** — transfer the "file", not the "text".

After copying, tighten permissions (NTFS) in PowerShell:

```powershell
icacls C:\agh-home\data\secrets /inheritance:r /grant:r "$env:USERNAME:R"
icacls C:\agh-home\secrets /inheritance:r /grant:r "$env:USERNAME:R"
```

## Step 5: Start the daemon (bind to the LAN)

Key difference: on the Mac it binds `127.0.0.1`; the server binds `0.0.0.0`:

```powershell
$env:AGH_HOME = "C:\agh-home"
$env:AGNES_PROFILE = "local-dev"
node C:\agnes-harness\packages\cli\dist\local\daemon.mjs `
  --profile local-dev `
  --workspace C:\agnes-harness `
  --data-dir C:\agh-home\data `
  --local-web-addr 0.0.0.0:4177 `
  --local-web-origin http://<LAN-IP-or-domain>:4177
```

> Verify locally first: open `http://localhost:4177` in a browser; only then
> expose it.

## Step 6: Firewall + auto-start + no sleep

```powershell
# Allow 4177 through the firewall (LAN-only profiles can tighten with -RemoteAddress LocalSubnet)
New-NetFirewallRule -DisplayName "AGH Web 4177" -Direction Inbound -Protocol TCP -LocalPort 4177 -Action Allow

# Auto-start on login (Task Scheduler)
schtasks /Create /TN "AGH daemon" /SC ONLOGON /TR ^
  "cmd /c set AGH_HOME=C:\agh-home&& set AGNES_PROFILE=local-dev&& node C:\agnes-harness\packages\cli\dist\local\daemon.mjs --profile local-dev --workspace C:\agnes-harness --data-dir C:\agh-home\data --local-web-addr 0.0.0.0:4177 --local-web-origin http://<IP>:4177" /F

# Disable sleep (a server must stay awake)
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

## Step 7: How others access it

| Where the other person is | Solution |
|---|---|
| Same LAN | Open `http://<windows-ip>:4177` directly |
| Remote | Install **Tailscale** (free) on both ends, log into the same account, open `http://<tailscale-ip>:4177` — encrypted with built-in auth, no public exposure |

### Remote deployment flow (when not on the same LAN)

Code and docs travel via GitHub; keys travel person-to-person; deployment is
driven by Claude Code on the target machine:

1. **Code via GitHub**: this repository (`HongboWanggl/Hacker`) already contains
   this document; a `git clone` on the far end gets all the code plus
   `docs/windows-server.md`.
2. **Keys by hand**: on the Mac, copy the 2–3 files from the Step 4 table to
   the other side's **desktop** (Sunflower file transfer etc.); never via git.
3. **Tailscale mesh**: install Tailscale on both ends, same account; run
   `ipconfig` on Windows and note the `100.x.x.x` Tailscale IP. All access goes
   through that IP afterwards; keep Sunflower only as a fallback / for files.
4. **Claude Code on the far end** runs the deployment (prompt below): install
   dependencies, move the keys into `C:\agh-home`, tighten NTFS permissions,
   configure the firewall and auto-start.
5. **Firewall**: with Tailscale in place the rule can be scoped to the Tailscale
   range (cleaner):
   ```powershell
   New-NetFirewallRule -DisplayName "AGH Web 4177 (Tailscale)" -Direction Inbound -Protocol TCP -LocalPort 4177 -Action Allow -RemoteAddress 100.64.0.0/10
   ```
   Log out of Sunflower when idle to reduce exposure.

Find the LAN IP: `ipconfig` (look for the IPv4 address).

## ⚠️ Security notes (important)

1. **The Web UI has no login auth**: anyone who can open the page can run
   tools, burn API quota, and read workspace files.
   - LAN deployment: at minimum scope the firewall rule to `LocalSubnet`
   - Public/remote: **always** use Tailscale, or put a reverse proxy in front
     (nginx/caddy + Basic Auth)
2. API keys live only in files (0600 / tightened NTFS), never in chat,
   screenshots, or git.
3. After the first deployment, run the smoke test below before sharing the URL.

## Smoke test checklist

- [ ] `http://localhost:4177` opens on the server itself
- [ ] `http://<windows-ip>:4177` opens from another device
- [ ] In the protein-predictor workspace, send `预测 P61626 的结构并分析置信度` and the panel renders
- [ ] Try one batch job and one complex job; confirm Ark routing and external APIs work
- [ ] After a Windows reboot the daemon auto-starts and the page is reachable

## Known risks / unverified

- AGH has no long-running track record on Windows; path separators / signal
  handling may hide surprises — deliver only after the smoke test passes.
- Local Boltz-2 (CUDA) is its own install project; migrate only after it is
  confirmed stable.
- Keep the local weights and keys on the Mac untouched until migration
  completes; the two sides can run in parallel.
