import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SongManifest } from '../types'

let root: Root | undefined
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.doUnmock('../songs')
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('HomePage catalogs without a featured song', () => {
  it.each(['syrinx-sample', 'flower-dance'])('opens %s from the playable catalog', async (id) => {
    const song: SongManifest = {
      id, title: id, composer: 'Composer', difficulty: 1, durationLabel: '0:04',
      keyLabel: 'C major', description: 'Practice', tags: [], scoreUrl: '/sample/score.musicxml',
      accent: '#5fb8a8', backgroundTheme: 'lumiere', bpm: 60,
    }
    vi.doMock('../songs', () => ({ SONGS: [song], DIFFICULTY_LABEL: { 1: '入门' } }))
    const { default: HomePage } = await import('./HomePage')
    const { useAppStore } = await import('../store')
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(createElement(HomePage)))
    const card = container.querySelector<HTMLButtonElement>('.song-grid button')!
    expect(card.textContent).toContain(id)
    await act(async () => card.click())
    expect(useAppStore.getState().view).toBe('preview')
    expect(useAppStore.getState().currentSongId).toBe(id)
  })
})
