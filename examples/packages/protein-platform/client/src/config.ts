export type PlatformConfig = {
  wsUrl: string | null
  profile: string
  rowId: string
  bffPath: string
  tasksRoot: string
}

// Relative fetch: the page lives at <mount>/ (hash routes never change the base).
export async function loadConfig(): Promise<PlatformConfig> {
  const r = await fetch('config.json', { cache: 'no-store' })
  if (!r.ok) throw new Error(`config.json ${r.status}`)
  return (await r.json()) as PlatformConfig
}
