---
name: protein-prediction
description: 蛋白质结构预测工作流：UniProt 取序列、ESMFold 结构预测、pLDDT 置信度分析的工具选择与结果判读标准
---
# 蛋白质结构预测工作流

为科研人员完成"序列 → 结构预测 → 置信度分析"的完整流水线时，遵循以下方法。

## 标准流程

1. **拿到输入**：
   - 用户给 UniProt accession（如 P04637）→ 直接 `uniprot_fetch`
   - 用户只给蛋白名/基因名 → 先 `uniprot_search` 找到 accession，和用户确认后再取序列
   - 用户直接给 FASTA/序列 → 跳过取序列步骤
2. **预测结构**：
   - 单链蛋白 → 用 `predict_structure`（ESMFold，单链 <400 残基效果最好，秒级返回，免费）。
     序列必须是大写单字母编码、无空格。
   - **多链复合物 / 蛋白-配体 / 蛋白-RNA** → 用 `predict_complex`（Boltz-2 共折叠，付费 API）：
     - `sequences` 传每条链的序列，逗号分隔（如 `seqA,seqB`）
     - `ligand_smiles` 传配体 SMILES（可选）
     - 返回 `ptm` / `iptm` / `bindingConfidence`（0-100）：ipTM≥80 接口高置信；bindingConfidence≥80
       可称"预测高置信结合"，50-80 提示"可能结合、需实验验证"
     - 长任务：`wait=false` 立即返回 predictionId；超时返回会带恢复指引——稍后用
       `prediction_id="<id>"`（传相同 sequences）再调用即可取结果，不会重复计费提交
     - **未配置密钥时自动走本地开源权重**（boltz-community CLI，Apple MPS）：报告带
       `engine: "boltz2-local"`，指标口径一致，但每个目标要跑几分钟、首次运行会下载
       ~10GB 权重；大复合物（>500 残基）建议配 API key；本地运行还会把 PAE 误差矩阵
       （`*_pae.npz`）存进工作区，面板自动渲染为可交互的误差热图（悬停读残基对误差，
       与 3D/曲线双向联动；超过 800 残基自动降采样显示），并附链间平均误差芯片与
       3D「按界面误差着色」模式（紫=界面可信，黄=界面误差大）
     - **长链回退**：单链 ≥400 残基时本工具也接受（ESMFold 免费端点对长链直接 413）；
       此时报告只含 pTM（无接口指标），verdict 形如 "high-confidence single-chain fold"。
     - 两者都没有时工具会返回配置指引，向用户转述即可（密钥放 `AGH_HOME/secrets/boltz/default`
       或环境变量 `BOLTZ_API_KEY`，值不要出现在对话里）
3. **置信度分析**：对产出的 PDB 运行 `analyze_confidence`，解读指标时使用下表。
4. **与 AlphaFold DB 对比（可选）**：用户提供 UniProt accession 且该蛋白在 AlphaFold DB
   有参考模型时，用 `compare_alphafold` 把预测与官方模型对比：
   - 返回 `caRmsd`（全链 CA-RMSD）、`caRmsdCore`（两侧 pLDDT≥70 残基上的 RMSD）和
     `meanAbsPlddtDelta`（逐残基 pLDDT 平均差）
   - 解读：core RMSD<2 Å 折叠高度一致；2-4 Å 整体一致、局部差异；全链 RMSD 远大于 core RMSD
     通常是内在无序区（IDR）贡献的，属预期而非失败
   - ESMFold 对无序区常常过度自信（pLDDT 虚高），所以 `largestDeltas` 若集中在末端/低复杂度区，
     应向用户解释为"ESMFold 在 IDR 上的置信度标定偏差"，而不是预测失败
   - 注意：RMSD 只在预测与参考覆盖相同残基编号时有意义；残基编号不重叠时工具会明确说明
     （例如只预测了截短 construct 的情况），此时不要强行给出折叠一致性结论

5. **任意两结构对比**：用户想对比两个已有的 PDB（WT vs 突变体、两个 construct、
   或预测 vs 已保存的 AlphaFold 参考）时，用 `compare_structures`：
   - 传 `structure_a`（主结构，面板彩色显示）和 `structure_b`（参考，灰色 ghost）
   - 残基按编号匹配——两个结构编号体系不同（如截短 construct 重新编号）时会明确拒绝，
     不要强行解读
   - 解读同 compare_alphafold：core RMSD<2 Å 高度一致；全链远大于核心时差异来自
     无序区；`largestDeltas` 集中在末端说明是 IDR 标定偏差
   - 与 compare_alphafold 的区别：那个工具联网取 AlphaFold DB 参考；这个只对比
     工作区里已有的两个文件，无需网络

## 置信度判读标准（pLDDT，0-100）

| 区间 | 含义 | 建议话术 |
|---|---|---|
| >90 | 很高置信（骨干+侧链取向准确） | 可直接用于下游建模 |
| 70-90 | 骨干可信，侧链取向需谨慎 | 正常折叠，细节待验证 |
| 50-70 | 低置信 | 可能是柔性区/无序区，不要过度解读 |
| <50 | 极低置信 | 大概率无序，AlphaFold 系模型视为"预测为无序" |

- 连续 ≥3 个残基 pLDDT<70 的区段要单独向用户指出，并提示可能是无序区而非预测失败
- 总体均值 ≥90 可称"高置信结构"；70-90 说明"骨架可靠、局部待验证"；<70 提醒用户谨慎

## 多蛋白批处理

**批量预测**：用户给多个 accession（或"预测这几个蛋白"）时，用 `batch_predict`
   一次完成取序列 + 折叠 + 置信度报告：
   - 逗号/空格分隔 accession（如 `P04637 P61626`），一次最多 8 个，超出会明确拒绝
   - 顺序执行（对免费 ESMFold 端点友好），每个蛋白约 10-30 s；两个蛋白约 20 s
   - 单个 accession 失败不会中断整批——失败行带原因（无效 accession / fetch 失败 /
     折叠失败），其余照常完成；向用户汇报时要逐条提及失败项及原因
   - 汇总返回 `summary.total / ok / failed / meanPlddt`（meanPlddt 是各蛋白均值的平均，
     只在至少一个成功时有）；需要更细的逐蛋白解读时对单个 PDB 再跑 `analyze_confidence`
   - >8 个 accession 时分多次调用，或改用批处理前先和用户确认优先级
   - 多链复合物 / 蛋白-配体不适合批处理，用 `predict_complex`

## 注意事项

- ESMFold 是单序列语言模型法：对孤儿序列（同源少的蛋白）精度低于 AF 系；多链复合物、
  配体结合场景改用 `predict_complex`（Boltz-2）
- ESMFold 请求返回 HTTP 413/422 通常是链太长（免费端点上限约 400 残基）：改用
  `predict_complex` 传同一条序列（Boltz-2 长链回退），不要反复重试
- `predict_complex` 配置了密钥时消耗 Boltz API 额度：先向用户确认再调用；未配密钥走本地权重
  （慢，几分钟一个目标）；单链任务一律用 `predict_structure`
- 涉及实验决策（如突变设计）时，明确说明"计算结果≠实验结论"
- 每次向用户报告时给出：PDB 文件路径、平均 pLDDT、低置信区段列表
