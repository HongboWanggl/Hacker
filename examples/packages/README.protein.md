# Protein structure prediction demo

A vertical-slice research pipeline for Agnes Harness: **UniProt sequence retrieval →
structure prediction → confidence analysis**, with an interactive structure &
confidence panel rendered directly in the workbench conversation.

## Packages

| Package | What it does |
|---|---|
| `@aghes/protein-predictor` | Agent tools: `uniprot_search`, `uniprot_fetch`, `predict_structure` (ESMFold, free), `analyze_confidence`, `predict_complex` (Boltz-2, paid, complexes/ligands), `compare_alphafold` (vs AlphaFold DB reference: pLDDT deltas + CA-RMSD via quaternion superposition), `compare_structures` (any two workspace PDBs — WT vs mutant, constructs — same engine, matched by residue number), `batch_predict` (fetch + fold up to 8 accessions in one call; per-job failures don't abort the batch) |
| `@aghes/protein-view` | Workbench panel for `predict_structure` / `analyze_confidence` / `compare_alphafold` / `batch_predict` results: big mean-pLDDT score card, confidence band bar, low-confidence segment chips, per-residue pLDDT curve, an interactive 3D backbone (canvas 2D painter's algorithm — no WebGL/CDN needed, CSP-safe), a comparison card (core/full-chain RMSD score, prediction-vs-reference pLDDT bars, largest-divergence residue chips, ΔpLDDT sparkline), and a batch card (per-accession rows with score chips and failure reasons;
click a row to expand an inline 3D + pLDDT-curve drill-down for that protein; multi-chain Boltz-2 complexes render with per-chain coloring, a chain legend (per-chain residue count and mean pLDDT), and `chain:residue` readouts), plus click-to-select on the 3D view, ←/→ keyboard residue stepping, a residue-number jump box, a band-colored residue sequence strip (third hover/click target synced with the 3D view and curve; the comparison card re-skins it as a |ΔpLDDT| divergence heat strip with a gradient legend), residue-numbered x-axis ticks on the curve, and band-percent legend) |

Both packages are self-contained (`examples/packages/...`) and install through the
normal package lifecycle (inspect → trust → enable) against a running daemon.
Ready-to-paste example prompts for every tool live in
[EXAMPLES.protein.md](EXAMPLES.protein.md). The full verification suite
(unit → SSR → client render → browser regression → live E2E) lives in
[dev-tests/](dev-tests) — `zsh dev-tests/run-all.sh [--live]`.

## The agent workflow

1. `uniprot_fetch P04637` — saves `sequences/P04637.fasta`, returns parsed metadata.
2. `predict_structure` — posts the sequence to ESMFold, saves `structures/<label>_<n>aa.pdb`
   (pLDDT in the B-factor column), and returns a structured confidence report.
3. `analyze_confidence` — band statistics + weakest contiguous segments (≥3 residues
   below pLDDT 70), optionally saved to `reports/*.confidence.json`.
4. `compare_alphafold P04637 structures/p53_1.pdb` — cross-checks the prediction
   against the AlphaFold DB reference model: mean |ΔpLDDT| per residue, the five
   largest confidence divergences, CA-RMSD after optimal superposition
   (Horn quaternion method, power iteration — no dependencies), a core RMSD
   restricted to residues both models call confidently, and a binned ΔpLDDT
   series the panel draws as a signed sparkline, and a 3D overlay — the tool
   saves the reference model and returns its superposition transform, so the
   panel renders the prediction (pLDDT colors) with the reference behind it as
   a gray ghost, sharing rotation/zoom with the rest of the panel.

For multi-protein jobs, `batch_predict P61626 P04637` fetches and folds each
accession sequentially (≤8 per call, ~10-30 s per protein, 1.5 s gap between
folds) and returns per-protein rows plus a summary — failed accessions are
listed with a reason instead of aborting the batch.

For complexes and protein–ligand jobs, `predict_complex` submits to Boltz-2
(`boltz-2.1`) and reports pTM/ipTM/binding confidence on top of the same PDB +
per-residue pLDDT pipeline. It needs a Boltz API key:

```sh
mkdir -p "$AGH_HOME/secrets/boltz"
printf %s "YOUR_KEY" > "$AGH_HOME/secrets/boltz/default"
chmod 600 "$AGH_HOME/secrets/boltz/default"
```

or `BOLTZ_API_KEY` in the daemon environment. The key is never echoed into
conversations or results.

## Screenshots

Captured from live sessions by `dev-tests/pv-screenshots.mjs` (2x DPI):

![Confidence panel: 3D backbone + pLDDT curve](docs/screenshots/confidence-3d-curve.png)
![Comparison card: core-RMSD score, 3D overlay, ΔpLDDT profile](docs/screenshots/compare-card.png)
![Cα-deviation lens: distance-colored strip and reference ghost](docs/screenshots/compare-dist-lens.png)
![Batch card](docs/screenshots/batch-card.png)
![UniProt search card](docs/screenshots/search-card.png)

## The panel

The workbench claims tool calls by name: `@aghes/protein-view` registers keyed
entries in the `tool.call.toolview` slot for `predict_structure`,
`analyze_confidence`, `compare_alphafold`, `predict_complex`,
`batch_predict`, `compare_structures`, and `uniprot_search`. When one of those
tools runs, the native "View details"
card is replaced by the panel (hover-synced between the 3D view and the curve;
click a residue in either to highlight it in the other; jump straight to any
residue via the toolbar box — chain-qualified `B:17` works on complexes; export
either view as a PNG; `uniprot_search` renders a structured hit table with
click-to-copy accessions).

Structure data reaches the browser through the `protein.structure` query service
registered by the plugin's backend runtime — the browser itself has no file
access; it sends the workspace-relative PDB path from the tool result and gets
back CA coordinates + per-residue pLDDT (0-100, normalized from ESMFold's 0-1
scale).

Hosts with the fiber-bound slot replay fix (packages/web-client
`createFiberBoundRegistry`) keep these registrations alive across session
switches; the plugin also re-asserts its own entries on slot re-declaration as a
fallback for older hosts.
