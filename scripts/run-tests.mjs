/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2]
const isCiMode = mode === 'ci'
const isCoverageMode = mode === 'coverage'
const vitestMode = mode === 'watch' ? 'watch' : 'run'
const scriptsDir = dirname(fileURLToPath(import.meta.url))
const repoDir = resolve(scriptsDir, '..')
const nodeGypBin = resolve(repoDir, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
let child = null
let cleanupStarted = false
let exitCode = 1
let exitSignal = null

function runCommand(command, args) {
  return new Promise((resolvePromise) => {
    const proc = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32'
    })

    proc.once('exit', (code, signal) => {
      resolvePromise({ code: code ?? 1, signal: signal ?? null })
    })
  })
}

async function restoreElectronAbi() {
  const packageJson = JSON.parse(await readFile(resolve(repoDir, 'package.json'), 'utf8'))
  const electronVersion = String(packageJson.devDependencies?.electron ?? '').replace(/^[^\d]*/, '')
  const moduleDir = resolve(repoDir, 'node_modules', 'better-sqlite3')

  const result = await new Promise((resolveCommand) => {
    const proc = spawn(
      process.execPath,
      [
        nodeGypBin,
        'rebuild',
        '--release',
        '--runtime=electron',
        `--target=${electronVersion}`,
        '--dist-url=https://electronjs.org/headers'
      ],
      {
        cwd: moduleDir,
        stdio: 'inherit',
        shell: process.platform === 'win32'
      }
    )

    proc.once('exit', (code, signal) => {
      resolveCommand({ code: code ?? 1, signal: signal ?? null })
    })
  })

  if (result.signal) {
    throw new Error(`restore interrupted by ${result.signal}`)
  }
  if (result.code !== 0) {
    throw new Error(`restore failed with exit code ${result.code}`)
  }
}

async function cleanup() {
  if (cleanupStarted || isCiMode) return
  cleanupStarted = true

  try {
    await restoreElectronAbi()
  } catch (error) {
    console.error('[tests] Failed to restore Electron native modules:', error)
    if (exitCode === 0 && !exitSignal) {
      exitCode = 1
    }
  }
}

async function finish() {
  await cleanup()

  if (exitSignal) {
    process.removeListener('SIGINT', handleSigint)
    process.removeListener('SIGTERM', handleSigterm)
    process.kill(process.pid, exitSignal)
    return
  }

  process.exit(exitCode)
}

function forwardSignal(signal) {
  exitSignal = signal

  if (child && !child.killed) {
    child.kill(signal)
    return
  }

  void finish()
}

const handleSigint = () => forwardSignal('SIGINT')
const handleSigterm = () => forwardSignal('SIGTERM')
process.on('SIGINT', handleSigint)
process.on('SIGTERM', handleSigterm)

async function main() {
  if (!isCiMode) {
    console.warn(
      '[tests] Do not run `npm test` and `npm run dev` simultaneously; ABI rebuilds swap the better-sqlite3 native binding. The restore step rebuilds Electron headers from the network, so a failed restore invalidates the run even if tests passed.'
    )

    const rebuildForNode = await runCommand('npm', ['rebuild', 'better-sqlite3'])
    if (rebuildForNode.signal) {
      exitSignal = rebuildForNode.signal
      return
    }
    if (rebuildForNode.code !== 0) {
      exitCode = rebuildForNode.code
      return
    }
  }

  const vitestArgs = ['vitest', vitestMode]
  if (isCoverageMode) vitestArgs.push('--coverage')

  child = spawn('npx', vitestArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })

  const result = await new Promise((resolvePromise) => {
    child.once('exit', (code, signal) => {
      resolvePromise({ code: code ?? 1, signal: signal ?? null })
    })
  })

  exitCode = result.code
  exitSignal = result.signal
}

try {
  await main()
} catch (error) {
  console.error('[tests] Test runner failed:', error)
  exitCode = 1
} finally {
  await finish()
}
