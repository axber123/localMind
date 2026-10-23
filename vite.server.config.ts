import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer')
    }
  },
  build: {
    ssr: resolve('src/server/index.ts'),
    outDir: 'dist/server',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    rollupOptions: {
      output: {
        format: 'esm',
        entryFileNames: 'index.mjs'
      }
    }
  }
})