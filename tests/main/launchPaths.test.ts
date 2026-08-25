import { describe, expect, it } from 'vitest'
import os from 'node:os'
import { join, resolve } from 'node:path'
import { presentationPathsFromArgv } from '../../src/main/launchPaths'

describe('presentationPathsFromArgv', () => {
  it('resolves relative presentations against the launching instance working directory', () => {
    const workingDirectory = join(os.tmpdir(), 'twig-second-instance')
    const absolutePath = resolve(os.tmpdir(), 'absolute.tb')

    expect(
      presentationPathsFromArgv(
        ['twig', 'relative.tb', absolutePath, 'notes.txt', 'UPPER.TB'],
        workingDirectory
      )
    ).toEqual([
      resolve(workingDirectory, 'relative.tb'),
      absolutePath,
      resolve(workingDirectory, 'UPPER.TB')
    ])
  })
})
