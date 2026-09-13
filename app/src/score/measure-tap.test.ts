import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindMeasureTap } from './measure-tap'

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); document.body.innerHTML = '' })
function setup() {
  const host = document.createElement('div')
  const child = document.createElement('div')
  host.append(child)
  document.body.append(host)
  const select = vi.fn()
  const cleanup = bindMeasureTap(host, select)
  cleanups.push(cleanup)
  const pointer = (type: string, x = 20, y = 30, id = 1, button = 0) => {
    const event = new Event(type, { bubbles: true })
    Object.assign(event, { clientX: x, clientY: y, pointerId: id, button })
    child.dispatchEvent(event)
  }
  return { host, child, select, cleanup, pointer }
}

describe('measure tap gesture', () => {
  it('selects once on a primary pointer tap and does not consume scrolling events', () => {
    const { pointer, select, child } = setup()
    pointer('pointerdown'); pointer('pointerup', 22, 31)
    child.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(select).toHaveBeenCalledExactlyOnceWith(22, 31)
  })
  it.each(['pointermove', 'scroll', 'wheel', 'pointercancel'])('cancels a tap after %s', (type) => {
    const { pointer, select, child } = setup()
    pointer('pointerdown')
    if (type.startsWith('pointer')) pointer(type, 40, 30)
    else child.dispatchEvent(new Event(type))
    pointer('pointerup')
    expect(select).not.toHaveBeenCalled()
  })
  it('does not turn a drag that returns to the origin into a tap', () => {
    const { pointer, select } = setup()
    pointer('pointerdown'); pointer('pointermove', 60, 30)
    pointer('pointermove'); pointer('pointerup')
    expect(select).not.toHaveBeenCalled()
  })
  it('rejects a moved pointerup even when no intermediate move event was delivered', () => {
    const { pointer, select } = setup()
    pointer('pointerdown'); pointer('pointerup', 100, 30)
    expect(select).not.toHaveBeenCalled()
  })
  it('rejects a long press', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const { pointer, select } = setup()
    pointer('pointerdown')
    now.mockReturnValue(700)
    pointer('pointerup')
    expect(select).not.toHaveBeenCalled()
    now.mockRestore()
  })
  it('cancels a second finger outside the score and a release outside the score', () => {
    const { pointer, select } = setup()
    const outside = (type: string, id: number) => {
      const event = new Event(type, { bubbles: true })
      Object.assign(event, { pointerId: id, button: 0, clientX: 20, clientY: 30 })
      document.body.dispatchEvent(event)
    }
    pointer('pointerdown'); outside('pointerdown', 2)
    outside('pointerup', 2); pointer('pointerup')
    pointer('pointerdown'); outside('pointerup', 1)
    expect(select).not.toHaveBeenCalled()
  })
  it('cancels both fingers of a pinch and accepts a subsequent single-finger tap', () => {
    const { pointer, select } = setup()
    pointer('pointerdown'); pointer('pointerdown', 30, 30, 2)
    pointer('pointerup'); pointer('pointerup', 30, 30, 2)
    expect(select).not.toHaveBeenCalled()
    pointer('pointerdown'); pointer('pointerup')
    expect(select).toHaveBeenCalledOnce()
  })
  it('ignores secondary buttons and removes every listener on disposal', () => {
    const { pointer, select, cleanup } = setup()
    pointer('pointerdown', 20, 30, 1, 2); pointer('pointerup', 20, 30, 1, 2)
    cleanup()
    pointer('pointerdown'); pointer('pointerup')
    expect(select).not.toHaveBeenCalled()
  })
})
