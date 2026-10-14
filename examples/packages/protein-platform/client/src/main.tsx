import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { createDaemonLink } from './agnes.ts'
import { initServices } from './bff.ts'
import { Shell } from './components/chrome.tsx'
import { loadConfig, type PlatformConfig } from './config.ts'
import { BatchView } from './views/batch.tsx'
import { BenchView } from './views/bench.tsx'
import { HelpView } from './views/help.tsx'
import { HomeView } from './views/home.tsx'
import { ResultView } from './views/result.tsx'
import { SearchView } from './views/search.tsx'
import { TasksView } from './views/tasks.tsx'
import './styles/platform.css'

async function boot() {
  const rootEl = document.getElementById('root')
  if (!rootEl) throw new Error('platform boot: #root element missing')
  const root = createRoot(rootEl)
  const cfg: PlatformConfig = await loadConfig()
  initServices(cfg)

  // Tasks left 'running' by a page switch/reload reattach to their daemon-side
  // session and replay to the true outcome (structure/archives recover too).
  const reattach = () =>
    import('./orchestrator.ts').then(({ reattachRunningTasks }) => void reattachRunningTasks(link))

  // A daemon restart latches the SDK client closed for good; the link replaces it
  // and calls back here, so a tab survives a restart without a manual reload.
  const link = createDaemonLink(cfg, { onRebuilt: reattach })

  let connected = link.state() === 'up'
  const render = () => {
    connected = link.state() === 'up'
    const hash = location.hash || '#/'
    let view = h(HomeView, { ready: connected, cfg, sdk: link })
    if (hash.startsWith('#/task/')) {
      view = h(ResultView, { taskId: decodeURIComponent(hash.slice('#/task/'.length)), cfg, sdk: link })
    } else if (hash.startsWith('#/tasks')) {
      view = h(TasksView)
    } else if (hash.startsWith('#/batch')) {
      view = h(BatchView, { ready: connected, cfg, sdk: link })
    } else if (hash.startsWith('#/search')) {
      view = h(SearchView, { ready: connected, cfg, sdk: link })
    } else if (hash.startsWith('#/bench')) {
      view = h(BenchView)
    } else if (hash.startsWith('#/help')) {
      view = h(HelpView)
    }
    root.render(h(Shell, { connected }, view))
  }
  addEventListener('hashchange', render)
  link.onState(render)
  render()

  try {
    await link.client()
    void reattach()
  } catch (e) {
    console.error('daemon connect failed', e)
  }
}

void boot()
