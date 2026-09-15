import { afterEach, describe, expect, it, vi } from 'vitest'
import { _recGainForTest, ensureRecGain } from './recGraph'

/** 录音元素 → WebAudio 增益图接线（t_2264e5ba）：
 *  HTMLAudioElement.volume 上限 1，直采录音电平偏低，回放卡经 gain 放大声。
 *  createMediaElementSource 每元素只允许一次——接线必须幂等。 */
function makeCtx() {
  return {
    destination: {},
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn() })),
    createMediaElementSource: vi.fn(() => ({ connect: vi.fn() })),
  }
}

const makeEl = () => ({ el: true }) as unknown as HTMLAudioElement

afterEach(() => {
  vi.clearAllMocks()
})

describe('ensureRecGain：接线', () => {
  it('建 source → gain → destination 链并返回 gain', () => {
    const ctx = makeCtx()
    const el = makeEl()
    const gain = ensureRecGain(el, ctx)
    expect(gain).not.toBeNull()
    expect(ctx.createMediaElementSource).toHaveBeenCalledWith(el)
    expect(ctx.createGain).toHaveBeenCalledTimes(1)
  })

  it('同一元素二次调用复用已建 gain（createMediaElementSource 仅允许一次）', () => {
    const ctx = makeCtx()
    const el = makeEl()
    const g1 = ensureRecGain(el, ctx)
    const g2 = ensureRecGain(el, ctx)
    expect(g1).toBe(g2)
    expect(ctx.createMediaElementSource).toHaveBeenCalledTimes(1)
  })

  it('接线抛错返回 null（调用方回退 element.volume 直控）', () => {
    const ctx = makeCtx()
    ctx.createMediaElementSource = vi.fn(() => {
      throw new Error('crossorigin')
    })
    expect(ensureRecGain(makeEl(), ctx)).toBeNull()
  })

  it('_recGainForTest 暴露表内 gain，未接线元素/空引用返回 null', () => {
    const ctx = makeCtx()
    const el = makeEl()
    expect(_recGainForTest(el)).toBeNull()
    const gain = ensureRecGain(el, ctx)
    expect(_recGainForTest(el)).toBe(gain)
    expect(_recGainForTest(null)).toBeNull()
  })
})
