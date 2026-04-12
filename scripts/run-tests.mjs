/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const mode = process.argv[2] === 'watch' ? 'watch' : 'run'
const rootDir = dirname(fileURLToPath(import.meta.url))
const repoDir = resolve(rootDir, '..')
let child = null
let cleanupStarted = false
let exitCode = 1
let exitSignal = null

function runCommand(command, args) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32'
    })

    proc.once('exit', (code, signal) => {
      resolve({ code: code ?? 1, signal: signal ?? null })
    })
  })
}

async function restoreElectronAbi() {
  const packageJson = JSON.parse(await readFile(resolve(repoDir, 'package.json'), 'utf8'))
  const electronVersion = String(packageJson.devDependencies?.electron ?? '').replace(/^[^\d]*/, '')
  const moduleDir = resolve(repoDir, 'node_modules', 'better-sqlite3')

  const result = await new Promise((resolveCommand) => {
    const proc = spawn(
      'npx',
      [
        'node-gyp',
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
  if (cleanupStarted) return
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
    process.removeAllListeners('SIGINT')
    process.removeAllListeners('SIGTERM')
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

process.on('SIGINT', () => forwardSignal('SIGINT'))
process.on('SIGTERM', () => forwardSignal('SIGTERM'))

async function main() {
  console.warn(
    '[tests] Do not run `npm test` and `npm run dev` simultaneously; ABI rebuilds swap the better-sqlite3 native binding.'
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

  child = spawn('npx', ['vitest', mode], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })

  const result = await new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      resolve({ code: code ?? 1, signal: signal ?? null })
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
