import { describe, expect, it } from 'vitest'
import { releaseBase } from './releaseBase'

describe('releaseBase', () => {
  it('uses the site root for development and an immutable directory for releases', () => {
    expect(releaseBase(undefined)).toBe('/')
    expect(releaseBase('2026.09.09-r1')).toBe('/releases/2026.09.09-r1/')
  })

  it('rejects release ids that could escape or alter the deployment path', () => {
    expect(() => releaseBase('../current')).toThrow('Invalid SYRINX_RELEASE_ID')
    expect(() => releaseBase('r1/preview')).toThrow('Invalid SYRINX_RELEASE_ID')
  })
})
