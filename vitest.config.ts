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
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/renderer/src/lib/i18n/**',
        'src/renderer/src/assets/**',
        'src/**/*.test.ts'
      ],
      all: true
    }
  }
})
