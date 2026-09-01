/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // 相对 base './'：构建产物不依赖部署路径，放服务器子路径或本地直接打开均可。
  base: './',
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
})
