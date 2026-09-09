import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import HistoryPage from './HistoryPage'
const mocked = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), remove: vi.fn(), clear: vi.fn() }))
vi.mock('../practice/history', () => ({ listPractices: mocked.list, getPractice: mocked.get, deletePractice: mocked.remove, clearPractices: mocked.clear }))
vi.mock('../songs', () => ({ getSong: () => ({ title: '测试曲' }) }))
const record = { sessionId: 'saved-2', songId: 'own-song', startedAt: 1, durationSec: 2, startSec: 4, stopSec: 6, mimeType: 'audio/wav', audioBlob: new Blob(['own recording']), pitchTrack: null, stats: null, schemaVersion: 1, practice: { songVersion: 'version', scoringVersion: 'pitch-v2-captured-notes', range: { startMeasure: 2, endMeasure: 2, startSec: 4, stopSec: 6 }, groupId: 'g', round: 2, rounds: 3 } }
let root: Root
let page: HTMLDivElement
beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mocked.list.mockReset().mockResolvedValue([record])
  mocked.get.mockReset().mockResolvedValue(record)
  mocked.remove.mockReset().mockResolvedValue(undefined)
  mocked.clear.mockReset().mockResolvedValue(undefined)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:restored')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  page = document.createElement('div'); document.body.appendChild(page); root = createRoot(page)
})
afterEach(async () => { await act(async () => root.unmount()); page.remove(); vi.restoreAllMocks() })
const render = async () => { await act(async () => root.render(createElement(HistoryPage))) }
const button = (text: string) => [...page.querySelectorAll('button')].find(b => b.textContent?.includes(text))!
it('opens the chosen record as its matching completed session without list-row object URLs', async () => {
  await render()
  expect(page.textContent).toContain('第 2 / 3 轮')
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  await act(async () => button('打开回放').click())
  expect(useAppStore.getState()).toMatchObject({ currentSongId: 'own-song', view: 'result', performanceSession: { id: 'saved-2', status: 'completed', take: { audioUrl: 'blob:restored' } } })
})
it('delete requires confirmation and removes the visible record after commit', async () => {
  await render()
  await act(async () => button('删除').click())
  expect(mocked.remove).not.toHaveBeenCalled()
  mocked.list.mockResolvedValue([])
  await act(async () => button('确认删除').click())
  expect(page.textContent).toContain('还没有练习记录')
})
it('clear failure stays visible and keeps existing records', async () => {
  mocked.clear.mockRejectedValue(new Error('storage unavailable'))
  await render()
  await act(async () => button('清空记录').click())
  expect(mocked.clear).not.toHaveBeenCalled()
  await act(async () => button('确认清空').click())
  expect(page.textContent).toContain('storage unavailable')
  expect(page.textContent).toContain('第 2 / 3 轮')
})
it('a late record fetch after leaving does not replace the active session or leak a URL', async () => {
  let resolve!: (value: typeof record) => void
  mocked.get.mockReturnValueOnce(new Promise(r => { resolve = r }))
  await render()
  await act(async () => button('打开回放').click())
  await act(async () => root.unmount())
  const id = useAppStore.getState().beginPerformance('new-song')
  await act(async () => resolve(record))
  expect(useAppStore.getState().performanceSession?.id).toBe(id)
  expect(URL.createObjectURL).not.toHaveBeenCalled()
})
