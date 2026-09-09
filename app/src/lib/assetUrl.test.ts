import { describe, expect, it } from 'vitest'
import { resolveAssetUrl } from './assetUrl'

describe('resolveAssetUrl', () => {
  it('places root-relative assets under the immutable release base', () => {
    expect(resolveAssetUrl('/songs/luv-letter/score.musicxml', {
      baseUrl: '/releases/r1-20260909/',
      origin: 'https://romanticjojo.com',
    })).toBe('https://romanticjojo.com/releases/r1-20260909/songs/luv-letter/score.musicxml')
  })

  it('rewrites only local song accompaniment MP3 paths in m4a release mode', () => {
    const options = {
      baseUrl: '/releases/r1/',
      origin: 'https://romanticjojo.com',
      audioFormat: 'm4a',
    }

    expect(resolveAssetUrl('/songs/luv-letter/accompaniment.mp3?v=2#start', options))
      .toBe('https://romanticjojo.com/releases/r1/songs/luv-letter/accompaniment.m4a?v=2#start')
    expect(resolveAssetUrl('/songs/luv-letter/preview.mp3?v=2', options))
      .toBe('https://romanticjojo.com/releases/r1/songs/luv-letter/preview.mp3?v=2')
  })

  it('leaves external, blob, data, and relative URLs untouched', () => {
    const options = { baseUrl: '/releases/r1/', origin: 'https://romanticjojo.com', audioFormat: 'm4a' }
    expect(resolveAssetUrl('https://cdn.example.test/accompaniment.mp3', options)).toBe('https://cdn.example.test/accompaniment.mp3')
    expect(resolveAssetUrl('blob:https://romanticjojo.com/id', options)).toBe('blob:https://romanticjojo.com/id')
    expect(resolveAssetUrl('data:audio/mpeg;base64,AA', options)).toBe('data:audio/mpeg;base64,AA')
    expect(resolveAssetUrl('songs/local.mp3', options)).toBe('songs/local.mp3')
  })
})
