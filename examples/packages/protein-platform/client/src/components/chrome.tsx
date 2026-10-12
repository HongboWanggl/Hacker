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

export function TopBar({ connected }: { connected: boolean }) {
  const hash = useHashRoute()
  const links = [
    { href: '#/', label: '首页', match: (h: string) => h === '#/' || h === '' },
    { href: '#/tasks', label: '任务', match: (h: string) => h.startsWith('#/task') },
    { href: '#/batch', label: '批量', match: (h: string) => h.startsWith('#/batch') },
    { href: '#/search', label: '检索', match: (h: string) => h.startsWith('#/search') },
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
