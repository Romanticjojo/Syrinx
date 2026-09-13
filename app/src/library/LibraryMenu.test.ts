import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import LibraryMenu from './LibraryMenu'

it('supports keyboard navigation, outside dismissal, and returns focus before invoking an action', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  const selected = vi.fn(() => expect(document.activeElement).toBe(trigger))
  await act(async () => root.render(createElement(LibraryMenu, { label: '更多', items: [
    { label: '编辑', onSelect: selected }, { label: '禁用', disabled: true, onSelect: vi.fn() }, { label: '移动', onSelect: vi.fn() },
  ] })))
  const trigger = host.querySelector('button')!
  const press = async (key: string) => act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) })
  await act(async () => { trigger.focus(); trigger.click() })
  expect(document.activeElement?.textContent).toBe('编辑')
  await press('ArrowDown')
  expect(document.activeElement?.textContent).toBe('移动')
  await press('Escape')
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  await act(async () => trigger.click())
  await act(async () => (document.activeElement as HTMLButtonElement).click())
  expect(selected).toHaveBeenCalledOnce()
  await act(async () => trigger.click())
  await act(async () => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  await act(async () => trigger.click())
  await act(async () => window.dispatchEvent(new Event('resize')))
  expect(document.activeElement).toBe(trigger)
  await act(async () => trigger.click())
  const outside = document.createElement('input'); document.body.append(outside)
  await act(async () => outside.focus())
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(document.activeElement).toBe(outside)
  outside.remove()
  await act(async () => root.unmount()); host.remove()
})
