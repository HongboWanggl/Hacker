#!/bin/zsh
# Unified test entry for the protein packages. Run from anywhere:
#   zsh examples/packages/dev-tests/run-all.sh          # fast suite (no network, ~1 min)
#   zsh examples/packages/dev-tests/run-all.sh --live   # + live E2E against 127.0.0.1:4177 (network, ~10 min)
# Prerequisites: daemon running with AGH_HOME pointing at the AGH home (web on :4177
# for regression/live), node + tsx available via `node --import tsx`.
set -e
cd "$(dirname "$0")"
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
VIEW_CLIENT="$ROOT/examples/packages/protein-view/extensions/main/client/index.js"

# Self-heal dependencies that live outside the repo.
if [ ! -d /tmp/pv-client-test ]; then mkdir -p /tmp/pv-client-test; fi
cp "$VIEW_CLIENT" /tmp/pv-client-test/index.js
if [ ! -d /tmp/node_modules/playwright-core ]; then
  echo "installing playwright-core into /tmp (test-only dependency)…"
  npm install --prefix /tmp playwright-core@1.64.0 --no-fund --no-audit --silent
fi

run() { echo "--- $1"; node --import tsx "$1" || exit 1; }
live() { echo "--- [live] $1"; node "$1" || exit 1; }

echo "=== unit (backend, mocked fs/net) ==="
run retry-unit.mts
run pairwise-unit.mts
run pairwise-overlap.mts
run boltz-flow-unit.mts
run structure-service-unit.mts
run confidence-multichain-unit.mts
run pae-service.mjs

echo "=== panel render: SSR ==="
run pv-render-compare.mjs
run pv-render-test.mjs

echo "=== panel render: client-side (createRoot, happy-dom) ==="
run pv-render-complex-live.mjs
run pv-render-compare3d-live.mjs
run pv-render-search-sort.mjs
run pv-pae-live.mjs
run pv-contact-live.mjs
run pv-jump-live.mjs
run pv-legend-live.mjs
run pv-tiletext.mjs
run pv-download-pdb.mjs
run pv-batch-live.mjs
run pv-kbd-strip.mjs             # sequence strip keyboard nav (listbox)
run pv-kbd-search.mjs             # search table keyboard roving (rows)
run pv-kbd-batch.mjs              # batch table keyboard toggle + roving
run pv-motion.mjs                 # auto-rotate respects prefers-reduced-motion
run pv-kbd-compare.mjs            # compare divergence strip inherits keyboard nav
run pv-drag-range.mjs             # strip mouse drag-select commits segment focus

if [ "${1:-}" = "--live" ]; then
  echo "=== live E2E (needs daemon + web on 4177) ==="
  run pv-e2e-verify2.mjs        # historical-session regression
  live pv-jump-e2e.mjs          # fresh predict + residue jump
  live pv-agnes-e2e.mjs         # full flow on agnes-ai route (unaffected by Ark 429)
  live pv-drill-live.mjs        # batch_predict + row drill-down
  live pv-pairwise-live.mjs     # compare_structures cross-check
  live pv-hover-e2e3.mjs        # compare overlay hover readout
  live pv-click-live.mjs        # 3D click-to-select + toggle-off
  live pv-export-live.mjs       # PNG export downloads
  live pv-search-live.mjs       # uniprot_search hit-table card
  live pv-dark-live.mjs         # dark-theme surfaces flip + restore
  live pv-kbd-live.mjs          # sequence strip keyboard nav (real keys)
  live pv-kbd-search-live.mjs   # search table keyboard roving (real keys)
  live pv-kbd-batch-live.mjs    # batch table keyboard toggle (real keys)
  live pv-motion-live.mjs       # auto-rotate follows emulated reduced-motion
  live pv-range-live.mjs        # jump box residue-range segment focus
  live pv-complex-guide.mjs     # predict_complex no-key guidance
  live af-e2e-live2.mjs         # compare_alphafold live run
  live pv-mobile-e2e.mjs        # fresh-session full loop at 400px phone width
fi

echo "ALL SUITES PASSED"
