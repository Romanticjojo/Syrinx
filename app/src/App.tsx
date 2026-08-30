import { useAppStore } from './store'
import HomePage from './views/HomePage'
import PreviewPage from './views/PreviewPage'
import PerformPage from './views/PerformPage'
import ResultPage from './views/ResultPage'

/** 视图路由：zustand 状态机（四个页面不值得引入路由库） */
export default function App() {
  const view = useAppStore((s) => s.view)

  switch (view) {
    case 'preview':
      return <PreviewPage />
    case 'perform':
      return <PerformPage />
    case 'result':
      return <ResultPage />
    case 'home':
    default:
      return <HomePage />
  }
}
