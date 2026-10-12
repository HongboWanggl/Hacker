import { apply } from '../../../protein-view/extensions/main/client/index.js'
import type { PvServices } from './bff.ts'

// Bind the protein-view toolview components into the platform app without
// touching protein-view: apply(ctx) with a capture shim (same shape the
// dev-tests happy-dom suites use). Returns toolName -> component.
export function bindProteinToolViews(services: PvServices): Map<string, any> {
  const registrations: Array<{ def: { key: string }; comp: any }> = []
  apply({
    agnes: { services },
    slots: {
      register(def: { key: string }, comp: any) {
        registrations.push({ def, comp })
      },
      spec: () => ({ kind: 'keyed' }),
      entriesOfSlot() {
        return registrations.map((r) => ({ options: r.def }))
      },
      subscribeDeclaration: () => () => {},
    },
    effect: (f: () => unknown) => {
      const off = f()
      return typeof off === 'function' ? off : undefined
    },
  } as any)
  return new Map(registrations.map((r) => [r.def.key, r.comp]))
}

// Minimal resultPreview that makes ProteinToolView self-serve, mirroring the
// transcript's 4096-char clip: `savedTo` must be regex-extractable, but the
// JSON must stay unparseable (parseReport → null) or the component treats it
// as the full report, skips the protein.report re-fetch, and — since savedTo
// here is a report path, not a .pdb — never recovers the structure path.
export function ownerProps(
  toolName: string,
  savedTo: string,
  services: PvServices,
  preview?: string,
  onPredict?: (accessions: string[]) => void,
  onCompare?: (job: { accession: string; savedTo?: string }) => void,
) {
  return {
    owner: {
      callId: 'platform',
      toolName,
      block: {
        // Explicit full preview (batch_predict's {jobs,summary}): parseable →
        // parseReport returns it → BatchCard dispatch. Default: truncated JSON
        // with an extractable savedTo → self-serve via protein.report.
        resultPreview: preview ?? `{"savedTo":"${savedTo}","clip":`,
      },
      // SearchCard's one-click predict hand-off (hit row ▶ / batch bar). Only
      // the platform builds owners, so the AGH transcript host never sees it.
      ...(onPredict ? { onPredict } : {}),
      // BatchCard drill-down's per-target AlphaFold compare hand-off (same
      // platform-only rule as onPredict).
      ...(onCompare ? { onCompare } : {}),
    },
    // ProteinToolView destructures { owner, services } — without this the
    // BFF fetch throws immediately and its silent .catch hides the failure.
    services,
  }
}
