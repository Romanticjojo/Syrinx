// Electron main process for Syrinx — loads the Vite build from ../dist (packaged) or dev server.
const { app, BrowserWindow, shell } = require('electron')
const path = require('path')

const DEV_URL = process.env.SYRINX_DEV_URL || 'http://localhost:5173'

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
      // 窗口被遮挡/失焦时不节流定时器与 rAF（t_perf_sync_tune）：
      // 微调页光标推进/试听看门狗依赖 rAF 与 setTimeout，遮挡节流会让每次
      // 操作退化到秒级卡顿；波形循环已改为按需重绘，空闲时本身零开销
      backgroundThrottling: false,
    },
  })

  // 应用内链接一律在新窗口交给系统浏览器（外链安全默认）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('file://') && !url.startsWith('http://localhost')) {
      shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'allow' }
  })

  if (app.isPackaged || process.env.SYRINX_PROD) {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  } else {
    win.loadURL(DEV_URL)
  }
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
