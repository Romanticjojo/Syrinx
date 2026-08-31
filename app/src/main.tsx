import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { initTheme } from './theme.ts'
import App from './App.tsx'
import SyncTunePage from './views/SyncTunePage.tsx'

// 渲染前同步主题，避免深浅闪跳
initTheme()

// 独立调试路由 /sync-tune/:songId（不进曲库导航；zustand 视图状态机之外）
const syncMatch = window.location.pathname.match(/\/sync-tune\/([\w-]+)/)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {syncMatch ? <SyncTunePage songId={syncMatch[1]} /> : <App />}
  </StrictMode>,
)
