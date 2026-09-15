import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LibraryDetail from './LibraryDetail'
import type { PersonalScore } from './types'
import { clearRuntimeSong } from '../songs/runtime'
import * as scoreEngine from './score'

const mocks = vi.hoisted(() => ({ resume: vi.fn(), synth: vi.fn(), load: vi.fn(), play: vi.fn() }))
vi.mock('../components/ScoreSheet', () => ({ default: ({ xml }: { xml: string | null }) => createElement('div', { 'data-testid': 'static-sheet' }, xml ? '乐谱已显示' : '') }))
vi.mock('../audio/AudioEngine', () => ({ audioEngine: { resume: mocks.resume, load: mocks.load, play: mocks.play, pause: () => {}, onEnd: undefined } }))
vi.mock('./piano', () => ({ synthesizePiano: mocks.synth }))
const xml = '<score-partwise><part-list><score-part id="F"><part-name>Flute</part-name></score-part></part-list><part id="F"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration></note></measure></part></score-partwise>'
const pianoXml = xml.replace('</part-list>', '<score-part id="P"><part-name>Piano 1</part-name></score-part><score-part id="P2"><part-name>Piano 2</part-name></score-part></part-list>').replace('</score-partwise>', '<part id="P"><measure number="1"><note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration></note></measure></part><part id="P2"><measure number="1"><note><pitch><step>D</step><octave>3</octave></pitch><duration>4</duration></note></measure></part></score-partwise>')
const record: PersonalScore = { id: 'test', fingerprint: 'a'.repeat(64), originalXml: pianoXml, title: '练习谱', composer: '', tags: [], favorite: false, createdAt: 1, updatedAt: 1, lastOpenedAt: null, settings: { melodyPartId: 'F', pianoPartIds: ['P'], mode: 'original', style: 'arpeggio', tonic: null, minor: false } }
let host: HTMLDivElement, root: Root
const settle = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 10)) }) }
const button = (text: string, parent: ParentNode = host) => [...parent.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.includes(text))!
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mocks.resume.mockReset().mockResolvedValue(undefined)
  mocks.synth.mockReset().mockResolvedValue({ duration: 2 })
  mocks.load.mockReset().mockResolvedValue(undefined)
  mocks.play.mockReset().mockResolvedValue(true)
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(createElement(LibraryDetail, { record, onBack: () => {}, onEdit: () => {}, onFavorite: () => {}, onSave: async (settings) => ({ ...record, settings }) })))
  await settle()
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); clearRuntimeSong(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('library settings and audition lifecycle', () => {
  it('keeps the dialog and focused field mounted while editing, and discards the draft on Escape', async () => {
    await act(async () => button('伴奏设置').click())
    const dialog = host.querySelector('[role="dialog"]')!
    const style = [...dialog.querySelectorAll('label')].find((label) => label.textContent?.startsWith('钢琴声部'))!.querySelector('select')!
    style.focus()
    await act(async () => { style.value = 'P2'; style.dispatchEvent(new Event('change', { bubbles: true })) })
    await settle()
    expect(host.querySelector('[role="dialog"]')).toBe(dialog)
    expect(document.activeElement).toBe(style)
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => button('伴奏设置').click())
    const reopened = [...host.querySelectorAll('label')].find((label) => label.textContent?.startsWith('钢琴声部'))!.querySelector('select')!
    expect(reopened.value).toBe('P')
    expect([...reopened.options].map(o => o.value)).toEqual(['P', 'P2'])
    expect(dialog.textContent).not.toMatch(/自动钢琴|织体|调性|可选择多个/)
  })
  it('does not begin expensive audio synthesis after cancelling a pending context resume', async () => {
    let release!: () => void
    mocks.resume.mockImplementation(() => new Promise<void>((resolve) => { release = resolve }))
    await act(async () => button('试听伴奏').click())
    await settle()
    await act(async () => button('取消准备').click())
    await act(async () => release())
    await settle()
    expect(mocks.synth).not.toHaveBeenCalled()
    expect(mocks.play).not.toHaveBeenCalled()
    expect(button('试听伴奏').disabled).toBe(false)
  })
  it('opens an old generated flute-only record as a static reader without any audio setup', async () => {
    const prepare = vi.spyOn(scoreEngine, 'prepareScore')
    const audioContext = vi.fn(function () { throw new Error('Read-only must not construct audio') })
    vi.stubGlobal('AudioContext', audioContext)
    const pure: PersonalScore = { ...record, id: 'pure', originalXml: xml, settings: { ...record.settings, mode: 'generated', pianoPartIds: [] } }
    await act(async () => root.render(createElement(LibraryDetail, { key: 'pure', record: pure, onBack: () => {}, onEdit: () => {}, onFavorite: () => {}, onSave: async settings => ({ ...pure, settings }) })))
    await settle()
    expect(host.textContent).toContain('乐谱已显示')
    expect(host.textContent).toContain('仅阅谱')
    expect(button('开始演奏')).toBeUndefined()
    expect(button('试听伴奏')).toBeUndefined()
    await act(async () => button('伴奏设置').click())
    const dialog = host.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('仅用于电子阅谱')
    expect(dialog.querySelectorAll('input[type="radio"], input[type="checkbox"]')).toHaveLength(0)
    await act(async () => button('保存设置', dialog).click())
    await settle()
    expect(prepare).not.toHaveBeenCalled()
    expect(audioContext).not.toHaveBeenCalled()
    expect(mocks.resume).not.toHaveBeenCalled()
    expect(mocks.synth).not.toHaveBeenCalled()
  })
})
