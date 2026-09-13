import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HomePage from './HomePage'

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.restoreAllMocks()
})

describe('web edition library entry', () => {
  it('keeps curated browsing available and opens a formal-version notice instead of file input', async () => {
    await act(async () => root.render(createElement(HomePage)))
    const tab = [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((el) => el.textContent?.includes('个人仓库'))
    expect(tab).toBeDefined()
    tab!.focus()
    await act(async () => tab!.click())
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('正式版本')
    expect(host.querySelector('input[type="file"]')).toBeNull()
    expect(host.querySelector('.song-grid')).not.toBeNull()
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(tab)
  })
})
