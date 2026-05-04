import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginSvelte from 'eslint-plugin-svelte'

export default tseslint.config(
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/out',
      '**/.claude',
      // Vendored from fabric v7 — preserve upstream for reviewable diffs
      'src/renderer/src/lib/alignment-guides/vendor/**',
      // tsc --build composite output (gitignored; not source)
      'electron.vite.config.js',
      'electron.vite.config.d.ts',
      'src/main/*.js',
      'src/main/*.d.ts',
      'src/preload/*.js',
      'src/preload/*.d.ts',
      'src/shared/*.js',
      'src/shared/*.d.ts',
      'src/renderer/src/lib/types.js',
      'src/renderer/src/lib/types.d.ts'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginSvelte.configs['flat/recommended'],
  {
    files: ['**/*.svelte', '**/*.svelte.ts'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser
      }
    }
  },
  {
    files: ['**/*.{tsx,svelte}'],
    rules: {
      'svelte/no-unused-svelte-ignore': 'off'
    }
  },
  eslintConfigPrettier
)
