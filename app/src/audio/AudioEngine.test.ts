import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * AudioEngine 状态单测（T1）：
 * 模块加载即 `new AudioContext()`（单例），所以每个用例先 stubGlobal 再
 * resetModules + 动态 import，拿到绑定 mock ctx 的全新实例。
 * 钉死的核心回归：suspended 时 play() 必须先 await resume 再 src.start()。
 */

/** 构造最小 AudioContext mock；sources 收集每次 createBufferSource 的产物 */
function makeCtx(opts: { resumeDelayMs?: number; resumeFails?: boolean } = {}) {
  const sources: {
    buffer: unknown
    playbackRate: { value: number }
    connect: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    onended: unknown
  }[] = []
  const ctx = {
    state: 'suspended' as AudioContextState,
    currentTime: 0,
    resume: vi.fn(async () => {
      if (opts.resumeDelayMs) await new Promise((r) => setTimeout(r, opts.resumeDelayMs))
      if (opts.resumeFails) throw new Error('autoplay denied')
      ctx.state = 'running'
    }),
    createGain: () => ({
      gain: { value: 1, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    }),
    createAnalyser: () => ({ fftSize: 0, connect: vi.fn() }),
    createBufferSource: () => {
      const s = {
        buffer: null,
        playbackRate: { value: 1 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
        onended: null,
      }
      sources.push(s)
      return s
    },
    createOscillator: () => ({
      type: '',
      frequency: { value: 0 },
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    }),
    decodeAudioData: vi.fn(),
    destination: {},
  }
  return { ctx, sources }
}

/** 挂 mock 并重建单例模块（new Ctor() 返回 ctx 对象，覆盖 this） */
async function freshEngine(ctx: unknown) {
  vi.resetModules()
  // 普通函数 new 调用时返回对象即实例（构造器返回对象覆盖 this）
  const Ctor = function () {
    return ctx
  } as unknown as new () => AudioContext
  vi.stubGlobal('AudioContext', Ctor)
  const { audioEngine } = await import('./AudioEngine')
  return audioEngine
}

const BUF = { duration: 5 } as unknown as AudioBuffer

beforeEach(() => {
  // watchEnd 用 rAF 轮询：替换成可控 stub，避免 happy-dom 定时器跨用例泄漏
  let seq = 0
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => ++seq))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('play()：suspended 时先 await resume 再 start', () => {
  it('resume 完成前不建 src（fire-and-forget 回归钉）；完成后 start 且 playing', async () => {
    const { ctx, sources } = makeCtx({ resumeDelayMs: 5 })
    const engine = await freshEngine(ctx)
    await engine.load(BUF)

    const p = engine.play()
    // 同步时刻：resume 已发起，但 src 尚未创建（旧实现会立刻 start -> 静音）
    expect(ctx.resume).toHaveBeenCalledTimes(1)
    expect(sources).toHaveLength(0)

    await p
    expect(sources).toHaveLength(1)
    expect(sources[0].start).toHaveBeenCalledTimes(1)
    expect(engine.playing).toBe(true)
    expect(engine.state).toBe('running')
    engine.pause() // 收掉 watchEnd 的 rAF 轮询
  })

  it('不 await 直接调用（PerformPage 兼容路径）不抛错', async () => {
    const { ctx } = makeCtx()
    const engine = await freshEngine(ctx)
    await engine.load(BUF)
    expect(() => {
      void engine.play()
    }).not.toThrow()
    // 等待内部 resume 微任务落定，避免悬挂 Promise
    await vi.waitFor(() => {
      expect(engine.playing).toBe(true)
    })
    engine.pause()
  })
})

describe('play()：resume 失败（仍 suspended）', () => {
  it('返回 false、不置 playing、不建 src、state 保持 suspended', async () => {
    const { ctx, sources } = makeCtx({ resumeFails: true })
    const engine = await freshEngine(ctx)
    await engine.load(BUF)

    const ok = await engine.play()
    expect(ok).toBe(false)
    expect(engine.playing).toBe(false)
    expect(sources).toHaveLength(0)
    expect(engine.state).toBe('suspended')
  })
})

describe('play()：running 状态直通', () => {
  it('不调 resume，同步建 src 并按 offset 启动', async () => {
    const { ctx, sources } = makeCtx()
    ctx.state = 'running'
    const engine = await freshEngine(ctx)
    await engine.load(BUF)

    const ok = await engine.play(2)
    expect(ok).toBe(true)
    expect(ctx.resume).not.toHaveBeenCalled()
    expect(sources[0].start).toHaveBeenCalledWith(0, 2)
    expect(engine.state).toBe('running')
    engine.pause()
  })
})

describe('play()：无缓冲', () => {
  it('返回 false 且不置 playing', async () => {
    const { ctx, sources } = makeCtx()
    const engine = await freshEngine(ctx)
    const ok = await engine.play()
    expect(ok).toBe(false)
    expect(engine.playing).toBe(false)
    expect(sources).toHaveLength(0)
  })
})

describe('state getter', () => {
  it('暴露 ctx.state（构造初始 suspended）', async () => {
    const { ctx } = makeCtx()
    const engine = await freshEngine(ctx)
    expect(engine.state).toBe('suspended')
    ctx.state = 'running'
    expect(engine.state).toBe('running')
  })
})

describe('pending playback lifecycle', () => {
  async function pendingEngine() {
    const { ctx, sources } = makeCtx()
    let resume!: () => void
    const resumed = new Promise<void>((resolve) => { resume = resolve })
    ctx.resume.mockImplementation(async () => { await resumed; ctx.state = 'running' })
    const engine = await freshEngine(ctx)
    await engine.load(BUF)
    return { engine, sources, resume }
  }

  it('pause cancels playback waiting for browser audio permission', async () => {
    const { engine, sources, resume } = await pendingEngine()
    const started = engine.play(2)
    engine.pause()
    resume()
    expect(await started).toBe(false)
    expect(sources).toHaveLength(0)
    expect(engine.playing).toBe(false)
  })

  it('loading another song cannot start it from a previous pending play', async () => {
    const { engine, sources, resume } = await pendingEngine()
    const started = engine.play(2)
    await engine.load({ duration: 9 } as AudioBuffer)
    resume()
    expect(await started).toBe(false)
    expect(sources).toHaveLength(0)
    expect(engine.time).toBe(0)
    expect(engine.duration).toBe(9)
  })

  it('a seek while waiting leaves the transport paused at the requested time', async () => {
    const { engine, sources, resume } = await pendingEngine()
    const started = engine.play(2)
    engine.seek(4)
    resume()
    expect(await started).toBe(false)
    expect(sources).toHaveLength(0)
    expect(engine.time).toBe(4)
  })

  it('two pending starts create only the latest audio source', async () => {
    const { engine, sources, resume } = await pendingEngine()
    const first = engine.play(1)
    const latest = engine.play(3)
    resume()
    expect(await first).toBe(false)
    expect(await latest).toBe(true)
    expect(sources).toHaveLength(1)
    expect(sources[0].start).toHaveBeenCalledWith(0, 3)
    engine.pause()
  })

  it('does not claim playback when resume resolves without restoring audio', async () => {
    const { ctx, sources } = makeCtx()
    ctx.resume.mockImplementation(async () => {})
    const engine = await freshEngine(ctx)
    await engine.load(BUF)
    expect(await engine.play()).toBe(false)
    expect(sources).toHaveLength(0)
  })
})
