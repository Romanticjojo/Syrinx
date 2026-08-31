/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Electron 打包用 file:// 协议加载，绝对路径 /assets/... 会指向盘符根；
  // 相对 base './' 让构建产物在 http（服务器部署）与 file（桌面端）下都能加载。
  base: './',
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
})
