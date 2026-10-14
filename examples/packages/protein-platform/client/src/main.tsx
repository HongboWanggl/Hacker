import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { connectDaemon } from './agnes.ts'
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

  let connected = false
  let sdk: Awaited<ReturnType<typeof connectDaemon>> | null = null
  try {
    sdk = await connectDaemon(cfg)
    connected = true
    // Tasks left 'running' by a page switch/reload reattach to their daemon-side
    // session and replay to the true outcome (structure/archives recover too).
    import('./orchestrator.ts').then(({ reattachRunningTasks }) => void reattachRunningTasks(sdk))
  } catch (e) {
    console.error('daemon connect failed', e)
  }

  const render = () => {
    const hash = location.hash || '#/'
    let view = h(HomeView, { ready: connected, cfg, sdk })
    if (hash.startsWith('#/task/')) {
      view = h(ResultView, { taskId: decodeURIComponent(hash.slice('#/task/'.length)), cfg, sdk })
    } else if (hash.startsWith('#/tasks')) {
      view = h(TasksView)
    } else if (hash.startsWith('#/batch')) {
      view = h(BatchView, { ready: connected, cfg, sdk })
    } else if (hash.startsWith('#/search')) {
      view = h(SearchView, { ready: connected, cfg, sdk })
    } else if (hash.startsWith('#/bench')) {
      view = h(BenchView)
    } else if (hash.startsWith('#/help')) {
      view = h(HelpView)
    }
    root.render(h(Shell, { connected }, view))
  }
  addEventListener('hashchange', render)
  render()
}

void boot()
