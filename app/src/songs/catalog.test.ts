import { describe, expect, it } from 'vitest'
import type { SongManifest } from '../types'
import { buildSongCatalog } from './catalog'

const song = (id: string): SongManifest => ({
  id,
  title: id,
  composer: 'Composer',
  difficulty: 1,
  durationLabel: '0:04',
  keyLabel: 'C major',
  description: 'A test song',
  tags: ['sample'],
  scoreUrl: `/${id}/score.musicxml`,
  accent: '#5fb8a8',
  backgroundTheme: 'lumiere',
  bpm: 60,
})

const modules = (...songs: SongManifest[]) =>
  Object.fromEntries(songs.map((value) => [`/public/songs/${value.id}/manifest.json`, { default: value }]))

describe('buildSongCatalog', () => {
  it('does not reintroduce retired score fixtures as playable songs', () => {
    const fixtures = modules(song('lumiere'), song('aurora-scale'))
    expect(buildSongCatalog(fixtures, song('syrinx-sample'), undefined))
      .toEqual([song('syrinx-sample')])
    expect(buildSongCatalog(fixtures, song('syrinx-sample'), 'lumiere,aurora-scale'))
      .toEqual([])
    expect(buildSongCatalog({ ...fixtures, ...modules(song('new-song')) }, song('syrinx-sample'), undefined))
      .toEqual([song('new-song')])
  })

  it('keeps the six private songs in the established product order', () => {
    const shuffled = modules(
      song('interstellar'),
      song('birds-poem'),
      song('luv-letter'),
      song('expedition-33'),
      song('river-flows-in-you'),
      song('flower-dance'),
    )

    expect(buildSongCatalog(shuffled, song('syrinx-sample'), undefined).map((item) => item.id)).toEqual([
      'luv-letter',
      'flower-dance',
      'river-flows-in-you',
      'expedition-33',
      'birds-poem',
      'interstellar',
    ])
  })

  it('uses the checked-in sample only when no usable private manifest exists', () => {
    const malformed = { default: { id: 'broken', title: 'Broken' } }

    expect(buildSongCatalog({ '/public/songs/broken/manifest.json': malformed }, song('syrinx-sample'), undefined))
      .toEqual([song('syrinx-sample')])
  })

  it('does not silently substitute the sample for an explicit unavailable allowlist', () => {
    const available = modules(song('luv-letter'))

    expect(buildSongCatalog(available, song('syrinx-sample'), 'missing, also-missing')).toEqual([])
  })

  it('filters and orders an explicit allowlist while ignoring duplicate and invalid ids', () => {
    const available = modules(song('flower-dance'), song('luv-letter'))

    expect(buildSongCatalog(available, song('syrinx-sample'), 'flower-dance, luv-letter,flower-dance,broken').map((item) => item.id))
      .toEqual(['flower-dance', 'luv-letter'])
  })
})
