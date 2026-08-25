import { describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'

vi.mock('electron', () => ({
  app: {
    getPath: (): string => process.cwd()
  }
}))

import { validateFilePath } from '../../src/main/db/connection'

describe('validateFilePath', () => {
  it('accepts twig extensions with any letter casing', () => {
    expect(() => validateFilePath(resolve('presentation.tb'))).not.toThrow()
    expect(() => validateFilePath(resolve('presentation.TB'))).not.toThrow()
    expect(() => validateFilePath(resolve('presentation.Tb'))).not.toThrow()
  })

  it('still rejects paths without a twig extension', () => {
    expect(() => validateFilePath(resolve('presentation.tb.backup'))).toThrow(
      'Invalid file extension'
    )
  })
})
