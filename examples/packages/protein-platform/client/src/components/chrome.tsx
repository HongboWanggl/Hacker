import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'

function useHashRoute(): string {
  const [hash, setHash] = useState(() => location.hash || '#/')
  useEffect(() => {
    const on = () => setHash(location.hash || '#/')
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return hash
}

// Light/dark switch. The boot script (theme.js) resolved the initial class from
// the system preference or the saved choice; clicking here writes an explicit
// choice. With no saved choice the system preference keeps controlling it live.
function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const on = () => {
      let saved: string | null = null
      try {
        saved = localStorage.getItem('pp-theme')
      } catch {
        saved = null
      }
      if (saved !== 'dark' && saved !== 'light') setDark(mq.matches)
    }
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  const flip = () => {
    const next = !dark
    setDark(next)
    document.documentElement.classList.toggle('dark', next)
    document.documentElement.style.colorScheme = next ? 'dark' : 'light'
    try {
      localStorage.setItem('pp-theme', next ? 'dark' : 'light')
    } catch {
      // storage unavailable (private mode): applies for this visit only
    }
  }
  return (
    <button type="button" className="pl-theme-btn" title={dark ? '切换浅色' : '切换深色'} onClick={flip}>
      {dark ? '☀️' : '🌙'}
    </button>
  )
}

export function TopBar({ connected }: { connected: boolean }) {
  const hash = useHashRoute()
  const links = [
    { href: '#/', label: '首页', match: (h: string) => h === '#/' || h === '' },
    { href: '#/tasks', label: '任务', match: (h: string) => h.startsWith('#/task') },
    { href: '#/batch', label: '批量', match: (h: string) => h.startsWith('#/batch') },
    { href: '#/search', label: '检索', match: (h: string) => h.startsWith('#/search') },
    { href: '#/bench', label: '基准', match: (h: string) => h.startsWith('#/bench') },
    { href: '#/help', label: '指南', match: (h: string) => h.startsWith('#/help') },
  ]
  return (
    <header className="pl-topbar">
      <div className="pl-brand">
        <div className="pl-brand-mark">🧬</div>
        蛋白质结构预测平台
      </div>
      <nav className="pl-nav">
        {links.map((l) => (
          <a
            key={l.href}
            href={l.href}
            className={`${l.match(hash) ? 'on' : ''} ${l.soon ? 'soon' : ''}`}
            title={l.soon ? '即将上线' : undefined}
          >
            {l.label}
          </a>
        ))}
      </nav>
      <ThemeToggle />
      <div className="pl-status">
        <span className={`pl-dot ${connected ? '' : 'off pulse'}`} />
        {connected ? '服务正常' : '连接中…'}
      </div>
    </header>
  )
}

export function Shell({ connected, children }: { connected: boolean; children: ReactNode }) {
  return (
    <>
      <TopBar connected={connected} />
      {children}
    </>
  )
}
