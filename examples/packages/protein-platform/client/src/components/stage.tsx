import { createElement as h, useEffect, useState } from 'react'
import type { PvServices } from '../bff.ts'

// The protein-view toolview (captured through the apply() shim) rendered inside a
// platform stage. Shared by the result page and the home-page candidate panel: both
// hand a tool name + an explicit resultPreview to the same components, so the two
// paths can never drift into rendering the same report differently.
export function ToolViewStage({
  toolName,
  savedTo,
  services,
  preview,
  onPredict,
  onCompare,
}: {
  toolName: string
  savedTo: string
  services: PvServices
  preview?: string
  onPredict?: (accessions: string[]) => void
  onCompare?: (job: { accession: string; savedTo?: string }) => void
}) {
  // biome-ignore lint/suspicious/noExplicitAny: compare result shape comes from the compare toolview, untyped by design
  const [comp, setComp] = useState<any>(null)
  useEffect(() => {
    let alive = true
    // Capture the protein-view components bound to our BFF-backed services.
    import('../pv.ts').then(({ bindProteinToolViews, ownerProps }) => {
      if (!alive) return
      const map = bindProteinToolViews(services)
      setComp({
        comp: map.get(toolName),
        props: ownerProps(toolName, savedTo, services, preview, onPredict, onCompare),
      })
    })
    return () => {
      alive = false
    }
  }, [toolName, savedTo, services, preview, onPredict, onCompare])
  if (!comp?.comp) return <div className="pl-empty">加载视图组件…</div>
  return <div className="pl-stage-wrap">{h(comp.comp, comp.props)}</div>
}
