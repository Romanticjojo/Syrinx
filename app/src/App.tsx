import { lazy, Suspense, useState } from 'react'
import Intro from './components/Intro'
import { useAppStore } from './store'
import HomePage from './views/HomePage'

const PreviewPage = lazy(() => import('./views/PreviewPage'))
const PerformPage = lazy(() => import('./views/PerformPage'))
const ResultPage = lazy(() => import('./views/ResultPage'))

/** 视图路由：zustand 状态机（四个页面不值得引入路由库）+ 入场动画覆盖层 */
export default function App() {
  const view = useAppStore((s) => s.view)
  // localStorage 记忆「下次不再播放」
  const [showIntro, setShowIntro] = useState(() => localStorage.getItem('syrinx_skip_intro') !== '1')

  return (
    <>
      {showIntro && <Intro onDone={() => setShowIntro(false)} />}
      <Suspense fallback={<div className="route-loading" role="status">正在打开…</div>}>
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
