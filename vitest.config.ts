import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Native addons like better-sqlite3 are more stable in forked workers than threads.
    pool: 'forks',
    restoreMocks: true
  }
})
