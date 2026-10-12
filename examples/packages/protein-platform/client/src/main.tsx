import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import { initServices } from './bff.ts'
import { Shell } from './components/chrome.tsx'
import { connectDaemon } from './agnes.ts'
import { loadConfig, type PlatformConfig } from './config.ts'
import { HomeView } from './views/home.tsx'
import { ResultView } from './views/result.tsx'
import { TasksView } from './views/tasks.tsx'
import { BatchView } from './views/batch.tsx'
import { SearchView } from './views/search.tsx'
import './styles/platform.css'

async function boot() {
  const root = createRoot(document.getElementById('root')!)
  const cfg: PlatformConfig = await loadConfig()
  const services = initServices(cfg)

  let connected = false
  let sdk: any = null
  try {
    sdk = await connectDaemon(cfg)
    connected = true
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
    }
    root.render(h(Shell, { connected }, view))
  }
  addEventListener('hashchange', render)
  render()
}

void boot()
