import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSiblingStagingPath,
  pathsReferToSameFile,
  replaceFilePreservingDestination
} from '../../src/main/files/atomicFile'

describe('safe database file replacement', () => {
  let testDir: string

  beforeEach(() => {
    testDir = fs.mkdtempSync(join(os.tmpdir(), 'twig-atomic-file-'))
  })

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('replaces an existing destination only after staging is complete', () => {
    const destination = join(testDir, 'deck.tb')
    const staging = createSiblingStagingPath(destination)
    fs.writeFileSync(destination, 'old presentation')
    fs.writeFileSync(staging, 'new presentation')

    replaceFilePreservingDestination(staging, destination)

    expect(fs.readFileSync(destination, 'utf8')).toBe('new presentation')
    expect(fs.existsSync(staging)).toBe(false)
  })

  it('detects hard-link aliases as the same destination', () => {
    const source = join(testDir, 'source.tb')
    const alias = join(testDir, 'alias.tb')
    fs.writeFileSync(source, 'presentation')
    fs.linkSync(source, alias)

    expect(pathsReferToSameFile(source, alias)).toBe(true)
  })
})
