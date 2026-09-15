// Syrinx Electron 主进程 — app:// 自定义协议加载 Vite 构建产物（web 模式 = 精选曲库）。
// 用自定义协议而非 file:// 是因为应用用绝对路径 /songs/... 引用媒体资源，
// file:// 下绝对路径会解析到盘符根；app:// 映射到安装目录内的 dist/ 根。
const { app, BrowserWindow, protocol, net, shell } = require('electron')
const path = require('path')
const url = require('url')

const DEV_URL = process.env.SYRINX_DEV_URL || 'http://localhost:5173'

// app:// 的 mime 表（covers musicxml/json/media）
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

// 安全边界：把 URL 收敛到 dist/ 目录内（防目录穿越）
const DIST_ROOT = path.join(__dirname, '..', 'dist')
const scheme = 'app'

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 演奏页依赖 rAF/定时器推进光标与录音；遮挡节流会造成卡顿
      backgroundThrottling: false,
    },
  })

  // 应用内链接一律交给系统浏览器（外链安全默认）
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (!target.startsWith('app://') && !target.startsWith('http://localhost')) {
      shell.openExternal(target)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  if (app.isPackaged || process.env.SYRINX_PROD) {
    win.loadURL('app://./index.html')
  } else {
    win.loadURL(DEV_URL)
  }
}

app.whenReady().then(() => {
  // registerSchemesAsPrivileged 需在 ready 前调用；这里 stream 协议 + 支持 fetch
  protocol.handle(scheme, (request) => {
    const parsed = url.parse(request.url)
    // app://./index.html → pathname '/index.html'
    let rel = decodeURIComponent(parsed.pathname || '/index.html')
    rel = rel.replace(/^\/+/, '')
    if (!rel) rel = 'index.html'
    const abs = path.normalize(path.join(DIST_ROOT, rel))
    if (!abs.startsWith(DIST_ROOT)) {
      return new Response('forbidden', { status: 403 })
    }
    const ext = path.extname(abs).toLowerCase()
    const mime = MIME[ext] || 'application/octet-stream'
    return net.fetch(url.pathToFileURL(abs).toString(), {
      headers: { 'content-type': mime },
    })
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
