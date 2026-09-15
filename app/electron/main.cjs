// Syrinx Electron 主进程 — app:// 自定义协议加载 Vite 构建产物（web 模式 = 精选曲库）。
// 用自定义协议而非 file:// 是因为应用用绝对路径 /songs/... 引用媒体资源，
// file:// 下绝对路径会解析到盘符根；app:// 映射到安装目录内的 dist/ 根。
const { app, BrowserWindow, protocol, net, shell } = require('electron')
const path = require('path')
const url = require('url')

const DEV_URL = process.env.SYRINX_DEV_URL || 'http://localhost:5173'
const scheme = 'app'

// 必须在 app ready 之前注册为 privileged：standard 让相对路径/同源成立，
// supportFetchAPI/stream 让 fetch 与媒体 Range 请求可用。
protocol.registerSchemesAsPrivileged([
  {
    scheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

// app:// 的 mime 表（covers musicxml/json/media；缺省由 net.fetch 按扩展名判断）
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
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
    if (target.startsWith(`${scheme}://`) || target.startsWith('http://localhost')) {
      return { action: 'allow' }
    }
    shell.openExternal(target)
    return { action: 'deny' }
  })

  if (app.isPackaged || process.env.SYRINX_PROD) {
    // standard scheme 下 host 随意取一个固定名，路径映射 dist/
    win.loadURL(`${scheme}://bundle/index.html`)
  } else {
    win.loadURL(DEV_URL)
  }
}

app.whenReady().then(() => {
  protocol.handle(scheme, (request) => {
    const parsed = url.parse(request.url)
    // app://bundle/index.html → pathname '/index.html'（host 恒为 bundle）
    let rel = decodeURIComponent(parsed.pathname || '/index.html')
    rel = rel.replace(/^\/+/, '')
    if (!rel) rel = 'index.html'
    const abs = path.normalize(path.join(DIST_ROOT, rel))
    if (!abs.startsWith(DIST_ROOT)) {
      return new Response('forbidden', { status: 403 })
    }
    const ext = path.extname(abs).toLowerCase()
    const mime = MIME[ext] || 'application/octet-stream'
    return net.fetch(url.pathToFileURL(abs).toString()).then(
      (res) =>
        new Response(res.body, {
          status: res.status,
          headers: { 'content-type': mime },
        }),
    )
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
