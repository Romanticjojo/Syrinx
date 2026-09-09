import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../songs', () => ({
  SONGS: [],
  DIFFICULTY_LABEL: { 1: '入门', 2: '进阶', 3: '演奏级' },
}))

import HomePage from './HomePage'

afterEach(() => {
  document.body.replaceChildren()
})

describe('HomePage empty catalog', () => {
  it('explains an explicitly filtered empty catalog without rendering broken navigation', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    await act(async () => root.render(createElement(HomePage)))

    expect(container.querySelector('[role="status"]')?.textContent).toContain('当前没有可用曲目')
    expect(container.querySelector('.debug-link')).toBeNull()
    await act(async () => root.unmount())
  })
})
