# dev-tests — protein 包验证套件

protein-predictor / protein-view 的全部验证资产。所有脚本可独立运行；
`run-all.sh` 是统一入口，会自愈外部依赖并按依赖顺序执行。

## 运行

```sh
# 快速套件（无网络，约 1 分钟）：单元 + SSR + 客户端渲染
zsh examples/packages/dev-tests/run-all.sh

# 完整套件（含 live E2E，需要 daemon + web 在 4177，走真实网络，约 10 分钟）
zsh examples/packages/dev-tests/run-all.sh --live
```

前置：daemon 以 `AGH_HOME=/Users/wanghanbao/agh-home` 运行（回归/live 需要
web 127.0.0.1:4177）；`node --import tsx` 可用。chrome-headless-shell 位于
`~/Library/Caches/ms-playwright/chromium_headless_shell-1234/...`（live E2E 用）。

## 外部依赖（故意不入库）

- `playwright-core@1.64.0` → runner 自动装到 `/tmp/node_modules`
- 面板客户端副本 → runner 每次从 protein-view 源码 cp 到 `/tmp/pv-client-test/`
  （SSR/客户端测试 import 这个副本，保证测的是当前源码）

## 覆盖矩阵

| 脚本 | 层 | 覆盖内容 |
|---|---|---|
| `retry-unit.mts` | 工具单元 | fetchRetry：5xx/429 重试、4xx 快速失败、网络错误重试、二次失败抛出 |
| `pairwise-unit.mts` | 工具单元 | compare_structures：刚性变换 RMSD=0、ΔpLDDT、标签、报告落盘、缺文件/过少残基拒绝 |
| `pairwise-overlap.mts` | 工具单元 | 残基编号不重叠时明确拒绝 |
| `boltz-flow-unit.mts` | 工具单元 | predict_complex 全生命周期（mock net.fetch）：wait=false 提交、Bearer→x-api-key 回退、轮询→下载→metrics 解析、失败任务透出、复合物守卫 |
| `structure-service-unit.mts` | 服务单元 | protein.structure 链感知解析：多链复合物不丢链、分组排序、0-1 pLDDT 归一、旧单链编号回归、去重/坏坐标跳过 |
| `confidence-multichain-unit.mts` | 工具单元 | analyze_confidence 多链：段落不跨链、`A:2-4` 链前缀、单链裸字符串回归、均值全残基 |
| `pv-render-compare.mjs` | 面板 SSR | 6 个 slot 注册；CompareCard（全链/核心 chips、条形、火花图、pairwise 标签）、BatchCard、ComplexCard |
| `pv-render-test.mjs` | 面板 SSR | 置信度面板基础渲染 |
| `pv-render-complex-live.mjs` | 面板客户端 | effects 执行后 3D/曲线真实挂载 |
| `pv-render-compare3d-live.mjs` | 面板客户端 | Compare3D 双结构加载 + ghost + 分歧序列条/图例 + chip→tile 联动 |
| `pv-jump-live.mjs` | 面板客户端 | 残基跳转框交互（合法/非法残基号）+ 键盘 ←/→ 逐残基步进与边界 clamp |
| `pv-click-live.mjs` | live E2E | 3D 点击选中残基（已选读出）+ 再次点击取消 |
| `pv-e2e-verify2.mjs` | 浏览器回归 | 历史会话打开 → 面板槽位存活（宿主重挂载修复的回归） |
| `pv-jump-e2e.mjs` | live E2E | 全新预测运行 + 跳转框 + 截图 |
| `pv-drill-live.mjs` | live E2E | batch_predict 运行 + 行内下钻 3D/曲线 |
| `pv-pairwise-live.mjs` | live E2E | compare_structures 与 compare_alphafold 数值交叉验证 |
| `pv-hover-e2e3.mjs` | live E2E | 叠加视图悬停互查读出 |
| `pv-export-live.mjs` | live E2E | 3D/曲线 PNG 导出真实下载 |
| `pv-search-live.mjs` | live E2E | uniprot_search 结构化命中表（点击复制 accession） |
| `pv-screenshots.mjs` | 文档资产 | 从历史会话抓取 4 张精选面板截图（2x DPI）到 docs/screenshots/，手动运行 |
| `pv-complex-guide.mjs` | live E2E | predict_complex 无密钥引导路径 |
| `af-e2e-live2.mjs` | live E2E | compare_alphafold 全流程（AFDB v6 API） |
| `agh-update-pp.mts` / `agh-update-view.mts` | 运维 | inspect→update→trust→enable 重发布 |

## 已知事项

- SSR（renderToString）不跑 effects：3D/工具栏（导出按钮、跳转框）只在
  客户端测试里断言，SSR 里断言加载态。
- live E2E 会往 workspaces 写真实数据、消耗 ESMFold/UniProt 免费额度；
  批处理/复合物等长任务脚本自带轮询超时。
- 合成 PDB 的 serial 列必须 5 位右对齐（`ATOM  ` + `padStart(5)`），否则
  parseCA 读错列——写新夹具时注意。
