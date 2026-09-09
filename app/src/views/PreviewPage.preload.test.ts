import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  preload: vi.fn(),
  cancelPending: vi.fn(),
  go: vi.fn(),
  setPracticeConfig: vi.fn(),
  song: {
    id: 'sample', title: 'Sample', composer: 'Composer', difficulty: 1,
    durationLabel: '0:04', keyLabel: 'C major', description: 'Description',
    tags: ['sample'], scoreUrl: '/sample/score.musicxml',
    accompanimentUrl: '/sample/accompaniment.mp3', accent: '#5fb8a8',
    backgroundTheme: 'lumiere', bpm: 60,
  },
  timeline: { durationSec: 4, secPerQuarter: 1, tempo: 60, notes: [], measureTimes: [] },
}))

vi.mock('../components/ScoreSheet', () => ({ default: () => createElement('div') }))
vi.mock('../audio/accompaniment', () => ({
  preloadAccompaniment: state.preload,
  cancelPendingAccompaniment: state.cancelPending,
}))
vi.mock('../songs', () => ({
  SONGS: [state.song],
  DIFFICULTY_LABEL: { 1: '入门', 2: '进阶', 3: '演奏级' },
  getSong: () => state.song,
  loadSong: async () => ({ xml: '<score-partwise/>', timeline: state.timeline }),
}))
vi.mock('../store', () => ({
  useAppStore: (selector: (value: unknown) => unknown) => selector({
    currentSongId: 'sample',
    go: state.go,
    setPracticeConfig: state.setPracticeConfig,
    toggleFavorite: vi.fn(),
    favorites: [],
  }),
}))

import PreviewPage from './PreviewPage'

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  state.preload.mockReset()
  state.cancelPending.mockReset()
  state.go.mockReset()
})

afterEach(() => document.body.replaceChildren())

describe('PreviewPage accompaniment preload', () => {
  it('explains synthesized fallback after preparing only the selected song', async () => {
    state.preload.mockResolvedValue({ buffer: { duration: 4 }, synthesized: true })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => root.render(createElement(PreviewPage)))
    await act(async () => undefined)

    expect(container.querySelector('.accompaniment-state')?.textContent).toContain('合成伴奏')
    expect(state.preload).toHaveBeenCalledOnce()
    expect(state.preload.mock.calls[0][0].id).toBe('sample')
    await act(async () => root.unmount())
  })

  it('offers a retry after preparation fails and reports success after retry', async () => {
    state.preload
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ buffer: { duration: 4 }, synthesized: false })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => root.render(createElement(PreviewPage)))
    await act(async () => undefined)
    const retry = Array.from(container.querySelectorAll('button')).find((button) => button.textContent?.includes('重试'))
    expect(retry).toBeDefined()

    await act(async () => retry!.click())
    await act(async () => undefined)
    expect(container.querySelector('.accompaniment-state')?.textContent).toContain('伴奏已准备')
    await act(async () => root.unmount())
  })

  it('cancels unfinished preload when leaving the selected song', async () => {
    state.preload.mockReturnValue(new Promise(() => {}))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => root.render(createElement(PreviewPage)))
    await act(async () => root.unmount())

    expect(state.cancelPending).toHaveBeenCalledWith('sample')
  })

  it('keeps unfinished preload alive while handing the same song to perform', async () => {
    state.preload.mockReturnValue(new Promise(() => {}))
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => root.render(createElement(PreviewPage)))
    const start = container.querySelector<HTMLButtonElement>('[aria-label="开始演奏"]')!
    await act(async () => start.click())
    await act(async () => root.unmount())

    expect(state.go).toHaveBeenCalledWith('perform', 'sample')
    expect(state.cancelPending).not.toHaveBeenCalled()
  })
})


it('offers a valid playback-bar range and clears it for normal whole-song playback', async () => {
  state.timeline.measureTimes = [{ measure: 1, time: 0, quarters: 0 }, { measure: 1, time: 2, quarters: 2 }] as never
  state.preload.mockResolvedValue({ buffer: { duration: 4 }, synthesized: false })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(createElement(PreviewPage)))
  const start = container.querySelector<HTMLSelectElement>('[aria-label="起始小节"]')
  expect(start).not.toBeNull()
  await act(async () => { start!.value = '2'; start!.dispatchEvent(new Event('change', { bubbles: true })) })
  await act(async () => [...container.querySelectorAll('button')].find(b => b.textContent?.includes('开始分段练习'))!.click())
  expect(state.setPracticeConfig).toHaveBeenLastCalledWith({ songId: 'sample', range: { startMeasure: 2, endMeasure: 2, startSec: 2, stopSec: 4 }, rounds: 3 })
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="开始演奏"]')!.click())
  expect(state.setPracticeConfig).toHaveBeenLastCalledWith(null)
  await act(async () => root.unmount())
})
