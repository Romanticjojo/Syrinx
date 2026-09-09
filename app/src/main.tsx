import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { initTheme } from './theme.ts'
import App from './App.tsx'
import { resolveSyncRoute, syncTunePath } from './synctune/route.ts'

const SyncTunePage = lazy(() => import('./views/SyncTunePage.tsx'))

// 渲染前同步主题，避免深浅闪跳
initTheme()

// 独立调试路由 /sync-tune/:songId（不进曲库导航；zustand 视图状态机之外）。
// 裸 /sync-tune（无 id）replaceState 补全为默认曲（R3 决策 1：不做 launcher 页，
// 刷新可保持完整 URL）；带 id 但不在曲库 → 页面内显示装配失败态
const syncRoute = resolveSyncRoute(window.location.pathname, window.location.search)
if (syncRoute?.needsReplace) {
  window.history.replaceState(null, '', syncTunePath(syncRoute.songId))
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<div className="route-loading" role="status">正在打开…</div>}>
      {syncRoute ? <SyncTunePage songId={syncRoute.songId} /> : <App />}
    </Suspense>
  </StrictMode>,
)
