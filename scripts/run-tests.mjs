/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2]
const vitestMode = mode === 'watch' ? 'watch' : 'run'
const scriptsDir = dirname(fileURLToPath(import.meta.url))
const repoDir = resolve(scriptsDir, '..')
const vitestBin = resolve(repoDir, 'node_modules', 'vitest', 'vitest.mjs')
const vitestArgs = [vitestBin, vitestMode]
if (mode === 'coverage') vitestArgs.push('--coverage')

// better-sqlite3 v13 ships an N-API module, so tests can launch Vitest directly.
const child = spawn(process.execPath, vitestArgs, {
  cwd: repoDir,
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

const forwardSignal = (signal) => {
  if (!child.killed) child.kill(signal)
}

process.on('SIGINT', forwardSignal)
process.on('SIGTERM', forwardSignal)

const result = await new Promise((resolveResult) => {
  child.once('error', (error) => resolveResult({ error, code: 1, signal: null }))
  child.once('exit', (code, signal) =>
    resolveResult({ error: null, code: code ?? (signal ? 1 : 0), signal })
  )
})

process.removeListener('SIGINT', forwardSignal)
process.removeListener('SIGTERM', forwardSignal)

if (result.error) {
  console.error('[tests] Failed to start Vitest:', result.error)
}

if (result.signal) {
  process.kill(process.pid, result.signal)
} else {
  process.exitCode = result.code
}
