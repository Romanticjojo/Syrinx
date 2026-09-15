import { beforeAll, describe, expect, it, vi } from 'vitest'

const loaded = vi.hoisted(() => ({ pages: [] as string[] }))

vi.mock('./store', () => ({
  useAppStore: (selector: (state: { view: string }) => unknown) => selector({ view: 'home' }),
}))
vi.mock('./components/Intro', () => ({ default: () => null }))
vi.mock('./views/HomePage', () => ({ default: () => null }))
vi.mock('./views/PreviewPage', () => {
  loaded.pages.push('preview')
  return { default: () => null }
})
vi.mock('./views/PerformPage', () => {
  loaded.pages.push('perform')
  return { default: () => null }
})
vi.mock('./views/ResultPage', () => {
  loaded.pages.push('result')
  return { default: () => null }
})

beforeAll(() => localStorage.setItem('syrinx_skip_intro', '1'))

describe('App route loading', () => {
  it('does not load preview, perform, or result modules while opening the homepage', async () => {
    await import('./App')
    expect(loaded.pages).toEqual([])
  })
})
