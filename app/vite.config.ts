/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { releaseBase } from './src/lib/releaseBase.ts'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: releaseBase(process.env.SYRINX_RELEASE_ID),
  // Only the app entry participates in dependency discovery. Private HTML
  // inspection files in public/ may reference old generated dependency paths.
  optimizeDeps: { entries: ['index.html'] },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
})
