import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PersonalLibrary from './PersonalLibrary'

const mocks = vi.hoisted(() => ({ list: vi.fn(), listSummaries: vi.fn(), listFolders: vi.fn(), createFolder: vi.fn(), moveScores: vi.fn(), getCover: vi.fn(), get: vi.fn() }))
vi.mock('./repository', () => ({ scoreRepository: mocks }))
vi.mock('./LibraryDetail', () => ({ default: () => null }))
vi.mock('./LibraryImport', () => ({ default: () => null }))
vi.mock('./LibraryMetadata', () => ({ default: ({ record }: { record: { id: string } }) => createElement('div', { 'data-editing-id': record.id }) }))
let host: HTMLDivElement, root: Root
const scores = Array.from({ length: 30 }, (_, i) => ({ id: `score-${i}`, title: `乐谱${String(i + 1).padStart(2, '0')}`, composer: '作者', tags: [], favorite: false, hasCover: false, createdAt: 100 - i, updatedAt: 100 - i, lastOpenedAt: null, settings: { melodyPartId: 'F', pianoPartIds: [], mode: 'none', style: 'arpeggio', tonic: null, minor: false } }))
const folders = [{ id: 'folder-1', name: '每日练习', createdAt: 1 }]
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === name || b.getAttribute('aria-label') === name)!
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) }) }
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear()
  mocks.list.mockResolvedValue(scores)
  mocks.listSummaries.mockResolvedValue(scores)
  mocks.listFolders.mockResolvedValue(folders)
  mocks.createFolder.mockReset().mockResolvedValue({ id: 'new-folder', name: '夜间练习', createdAt: 2 })
  mocks.moveScores.mockReset().mockResolvedValue(undefined)
  mocks.getCover.mockReset().mockResolvedValue(null)
  mocks.get.mockReset()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await act(async () => root.render(createElement(PersonalLibrary)))
  await settle()
})
afterEach(async () => { await act(async () => root.unmount()); host.remove() })

describe('personal library collections and scalable browsing', () => {
  it('ignores an earlier edit response after another score was selected', async () => {
    let resolveA!: (value: unknown) => void, resolveB!: (value: unknown) => void
    mocks.get.mockImplementation((id: string) => new Promise((resolve) => { if (id === 'score-0') resolveA = resolve; else resolveB = resolve }))
    await act(async () => button('乐谱01 的更多操作').click())
    await act(async () => button('编辑信息').click())
    await act(async () => button('乐谱02 的更多操作').click())
    await act(async () => button('编辑信息').click())
    await act(async () => resolveB({ ...scores[1], originalXml: '<score-partwise/>' }))
    expect(host.querySelector('[data-editing-id]')?.getAttribute('data-editing-id')).toBe('score-1')
    await act(async () => resolveA({ ...scores[0], originalXml: '<score-partwise/>' }))
    expect(host.querySelector('[data-editing-id]')?.getAttribute('data-editing-id')).toBe('score-1')
  })
  it('creates an empty folder without requiring a score', async () => {
    await act(async () => button('仓库选项').click())
    expect(button('新建文件夹')).toBeDefined()
    await act(async () => button('新建文件夹').click())
    const input = host.querySelector<HTMLInputElement>('input[aria-label="文件夹名称"]')!
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '夜间练习'); input.dispatchEvent(new Event('input', { bubbles: true })) })
    await act(async () => button('创建文件夹').click())
    expect(mocks.createFolder).toHaveBeenCalledWith('夜间练习')
  })
  it('moves several selected scores through one explicit folder action', async () => {
    expect(host.querySelector('input[type="checkbox"]')).toBeNull()
    await act(async () => button('仓库选项').click())
    await act(async () => button('选择乐谱').click())
    const first = host.querySelector<HTMLInputElement>('input[aria-label="选择 乐谱01"]')
    expect(first).not.toBeNull()
    await act(async () => { first!.click(); host.querySelector<HTMLInputElement>('input[aria-label="选择 乐谱02"]')!.click() })
    await act(async () => button('移动到文件夹').click())
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="目标文件夹"]')!
    await act(async () => { select.value = 'folder-1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => button('确认移动').click())
    expect(mocks.moveScores).toHaveBeenCalledWith(['score-0', 'score-1'], 'folder-1')
  })
  it('keeps ordinary browsing quiet and cancels selections when leaving organize mode', async () => {
    expect(button('编辑信息')).toBeUndefined()
    expect(button('导出备份')).toBeUndefined()
    expect(host.querySelector('input[type="checkbox"]')).toBeNull()
    await act(async () => button('仓库选项').click())
    await act(async () => button('选择乐谱').click())
    await act(async () => button('选择本页').click())
    expect(host.querySelectorAll('input:checked')).toHaveLength(24)
    await act(async () => button('完成整理').click())
    expect(host.querySelector('input[type="checkbox"]')).toBeNull()
  })
  it('collects a batch across pages instead of losing previous selections', async () => {
    await act(async () => button('仓库选项').click())
    await act(async () => button('选择乐谱').click())
    await act(async () => button('选择本页').click())
    await act(async () => button('下一页').click())
    expect(host.querySelector('[aria-label="整理乐谱"]')?.textContent).toContain('已选 24 份')
    await act(async () => button('选择本页').click())
    await act(async () => button('移动到文件夹').click())
    await act(async () => button('确认移动').click())
    expect(mocks.moveScores).toHaveBeenCalledWith(scores.map(score => score.id), null)
  })
  it('filters a folder without displaying a growing shelf of navigation chips', async () => {
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="浏览文件夹"]')!
    expect(select).not.toBeNull()
    await act(async () => { select.value = 'folder-1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(host.querySelectorAll('.library-card')).toHaveLength(0)
    expect(host.textContent).toContain('这个文件夹还没有乐谱')
    await act(async () => button('仓库选项').click())
    expect(button('重命名文件夹')).toBeDefined()
  })
  it('lets users browse and manage an empty folder before importing their first score', async () => {
    mocks.listSummaries.mockResolvedValue([])
    await act(async () => root.render(createElement(PersonalLibrary, { key: 'empty' })))
    await settle()
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="浏览文件夹"]')!
    expect(select).not.toBeNull()
    await act(async () => { select.value = 'folder-1'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    await act(async () => button('仓库选项').click())
    expect(button('重命名文件夹')).toBeDefined()
  })
  it('paginates cards and supports a compact list without loading original XML', async () => {
    expect(host.querySelectorAll('.library-card')).toHaveLength(24)
    await act(async () => button('下一页').click())
    expect(host.querySelectorAll('.library-card')).toHaveLength(6)
    await act(async () => button('列表视图').click())
    expect(host.querySelectorAll('.library-list-row')).toHaveLength(30)
    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.getCover).not.toHaveBeenCalled()
  })
})
