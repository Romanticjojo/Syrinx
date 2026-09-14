import { lazy, Suspense, useState } from 'react'
import Intro from './components/Intro'
import { useT } from './i18n'
import { useAppStore } from './store'
import HomePage from './views/HomePage'

const PreviewPage = lazy(() => import('./views/PreviewPage'))
const PerformPage = lazy(() => import('./views/PerformPage'))
const ResultPage = lazy(() => import('./views/ResultPage'))

/** 懒加载路由的 Suspense 兜底（main.tsx 的 SyncTunePage 分支复用同一组件） */
export function RouteLoading() {
  const t = useT()
  return <div className="route-loading" role="status">{t('common.loading')}</div>
}

/** 视图路由：zustand 状态机（四个页面不值得引入路由库）+ 入场动画覆盖层 */
export default function App() {
  const view = useAppStore((s) => s.view)
  // localStorage 记忆「下次不再播放」
  const [showIntro, setShowIntro] = useState(() => localStorage.getItem('syrinx_skip_intro') !== '1')

  return (
    <>
      {showIntro && <Intro onDone={() => setShowIntro(false)} />}
      <Suspense fallback={<RouteLoading />}>
        {view === 'preview' ? (
          <PreviewPage />
        ) : view === 'perform' ? (
          <PerformPage />
        ) : view === 'result' ? (
          <ResultPage />
        ) : (
          <HomePage />
        )}
      </Suspense>
    </>
  )
}
