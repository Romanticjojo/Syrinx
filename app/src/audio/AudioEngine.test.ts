import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * AudioEngine 状态单测（T1）：
 * 模块加载即 `new AudioContext()`（单例），所以每个用例先 stubGlobal 再
 * resetModules + 动态 import，拿到绑定 mock ctx 的全新实例。
 * 钉死的核心回归：suspended 时 play() 必须先 await resume 再 src.start()。
 */

/** 构造最小 AudioContext mock；sources 收集每次 createBufferSource 的产物 */
function makeCtx(opts: { resumeDelayMs?: number; resumeFails?: boolean } = {}) {
  const mediaSources: { element: HTMLMediaElement; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
  const sources: {
    buffer: unknown
    playbackRate: { value: number }
    connect: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
    onended: unknown
  }[] = []
  const oscillators: { stop: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[] = []
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
      disconnect: vi.fn(),
    }),
    createAnalyser: () => ({ fftSize: 0, connect: vi.fn() }),
    createMediaElementSource: (element: HTMLMediaElement) => {
      const source = { element, connect: vi.fn(), disconnect: vi.fn() }
      mediaSources.push(source)
      return source
    },
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
    createOscillator: () => {
      const oscillator = {
        type: '',
        frequency: { value: 0 },
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
      }
      oscillators.push(oscillator)
      return oscillator
    },
    decodeAudioData: vi.fn(),
    destination: {},
  }
  return { ctx, sources, oscillators, mediaSources }
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
  vi.useRealTimers()
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

function pcmBuffer(duration = 5) {
  const data = new Float32Array(duration * 8000)
  return { duration, length: data.length, sampleRate: 8000, numberOfChannels: 1, getChannelData: () => data } as unknown as AudioBuffer
}

/** The browser boundary is faked; WAV encoding and transport state stay real. */
function mockMedia(options: { supported?: boolean; metadata?: boolean } = {}) {
  const elements: (EventTarget & {
    preservesPitch?: boolean
    playbackRate: number
    currentTime: number
    readyState: number
    src: string
    preload: string
    paused: boolean
    ended: boolean
    play: ReturnType<typeof vi.fn>
    pause: ReturnType<typeof vi.fn>
    load: ReturnType<typeof vi.fn>
    removeAttribute: ReturnType<typeof vi.fn>
  })[] = []
  vi.stubGlobal('Audio', function () {
    const element = Object.assign(new EventTarget(), {
      ...(options.supported === false ? {} : { preservesPitch: false }),
      playbackRate: 1,
      currentTime: 0,
      readyState: 0,
      src: '',
      preload: '',
      paused: true,
      ended: false,
      play: vi.fn(async () => { element.paused = false }),
      pause: vi.fn(() => { element.paused = true }),
      load: vi.fn(() => {
        if (element.src && options.metadata !== false) {
          element.readyState = 1
          element.dispatchEvent(new Event('loadedmetadata'))
        }
      }),
      removeAttribute: vi.fn((attribute: string) => { if (attribute === 'src') element.src = '' }),
    })
    elements.push(element)
    return element
  })
  const createObjectURL = vi.fn((_blob: Blob) => `blob:audio-${elements.length}`)
  const revokeObjectURL = vi.fn()
  vi.stubGlobal('URL', class extends URL {
    static createObjectURL = createObjectURL
    static revokeObjectURL = revokeObjectURL
  })
  return { elements, createObjectURL, revokeObjectURL }
}

describe('pitch-preserving tempo transport', () => {
  it.each(['original', 'media'] as const)('%s keeps an exact paused seek at a measure boundary despite native clock quantization', async (transport) => {
    const { ctx } = makeCtx()
    ctx.state = 'running'
    const media = mockMedia()
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer(20))
    if (transport === 'media') {
      expect(await engine.setRate(0.5)).toBe(true)
      let nativeTime = 0
      Object.defineProperty(media.elements[0], 'currentTime', {
        get: () => nativeTime,
        set: (value: number) => { nativeTime = Math.floor(value * 2 ** 20) / 2 ** 20 },
      })
    }
    const boundary = 11.428571428571
    engine.seek(boundary)
    if (transport === 'media') expect(media.elements[0].currentTime).toBe(11.428570747375488)
    expect(engine.time).toBe(boundary)
    engine.pause()
    expect(engine.time).toBe(boundary)
    expect(engine.playing).toBe(false)

    // Keeping the exact request must not snap a nearby earlier position forward.
    engine.seek(boundary - 1e-9)
    expect(engine.time).toBe(boundary - 1e-9)
  })

  it('media starts and both seek directions never report before their exact requested position', async () => {
    const { ctx } = makeCtx()
    ctx.state = 'running'
    const media = mockMedia()
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer(20))
    expect(await engine.setRate(0.5)).toBe(true)
    let nativeTime = 0
    Object.defineProperty(media.elements[0], 'currentTime', {
      get: () => nativeTime,
      set: (value: number) => { nativeTime = Math.floor(value * 2 ** 20) / 2 ** 20 },
    })
    const boundary = 11.428571428571
    expect(await engine.play(boundary)).toBe(true)
    expect(nativeTime).toBeLessThan(boundary)
    expect(engine.time).toBe(boundary)

    nativeTime = boundary + 0.25
    ctx.currentTime = 90
    expect(engine.time).toBe(nativeTime)
    for (const target of [17.142857142857, 5.7142857142855]) {
      engine.seek(target)
      expect(nativeTime).toBeLessThan(target)
      expect(engine.time).toBe(target)
    }
    expect(media.elements[0].play).toHaveBeenCalledOnce()

    // Only the requested start is a lower bound, not the next measure boundary.
    nativeTime = boundary - 1e-9
    expect(engine.time).toBeLessThan(boundary)
    engine.pause()
    expect(engine.time).toBe(nativeTime)
  })

  it('encodes a local WAV with the original sample rate, stereo order and signed PCM samples', async () => {
    const { ctx } = makeCtx()
    const media = mockMedia()
    const engine = await freshEngine(ctx)
    const channels = [new Float32Array([-1, 0, 1]), new Float32Array([0.5, -0.5, 2])]
    await engine.load({
      duration: 3 / 48000, length: 3, sampleRate: 48000, numberOfChannels: 2,
      getChannelData: (channel: number) => channels[channel],
    } as AudioBuffer)
    expect(await engine.setRate(0.75)).toBe(true)
    const blob = media.createObjectURL.mock.calls[0][0] as Blob
    expect(blob.type).toBe('audio/wav')
    const bytes = await blob.arrayBuffer()
    const view = new DataView(bytes)
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
    expect(new TextDecoder().decode(bytes.slice(8, 12))).toBe('WAVE')
    expect(view.getUint32(4, true)).toBe(48)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(24, true)).toBe(48000)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getUint32(40, true)).toBe(12)
    expect(Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true))).toEqual([-32768, 16383, 0, -16384, 32767, 32767])
  })

  it('yields during a long WAV conversion and can cancel before creating any media URL', async () => {
    const { ctx } = makeCtx()
    const media = mockMedia()
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer(300))
    vi.useFakeTimers()
    const rate = engine.setRate(0.75)
    await vi.runOnlyPendingTimersAsync()
    expect(media.createObjectURL).not.toHaveBeenCalled()
    engine.pause()
    await vi.runAllTimersAsync()
    expect(await rate).toBe(false)
    expect(engine.rate).toBe(1)
  })

  it('keeps original playback native, then routes changed and restored rates through pitch-preserving media', async () => {
    const { ctx, sources, mediaSources } = makeCtx()
    ctx.state = 'running'
    const media = mockMedia()
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer())
    await engine.play(1)
    ctx.currentTime = 1
    engine.pause()
    expect(engine.time).toBe(2)

    expect(await engine.setRate(0.75)).toBe(true)
    expect(engine.rate).toBe(0.75)
    expect(engine.time).toBe(2)
    expect(media.elements[0].preservesPitch).toBe(true)
    expect(media.elements[0].playbackRate).toBe(0.75)
    expect(mediaSources[0].connect).toHaveBeenCalledWith(sources[0].connect.mock.calls[0][0])
    expect(await engine.play()).toBe(true)
    media.elements[0].currentTime = 2.375
    ctx.currentTime = 90
    expect(engine.time).toBe(2.375)
    engine.pause()
    expect(engine.time).toBe(2.375)

    expect(await engine.setRate(1)).toBe(true)
    await engine.play()
    expect(sources).toHaveLength(1)
    expect(media.elements).toHaveLength(1)
    expect(media.elements[0].playbackRate).toBe(1)
    engine.pause()
  })

  it.each([0.5, 1.5])('supports the inclusive rate boundary %s', async (rate) => {
    const { ctx } = makeCtx()
    mockMedia()
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer())
    expect(await engine.setRate(rate)).toBe(true)
    expect(engine.rate).toBe(rate)
  })

  it.each([0, 0.49, 1.51, NaN, Infinity])('rejects invalid rate %s without changing the song position', async (rate) => {
    const { ctx } = makeCtx()
    const media = mockMedia()
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer())
    engine.seek(3)
    expect(await engine.setRate(rate)).toBe(false)
    expect(engine.rate).toBe(1)
    expect(engine.time).toBe(3)
    expect(media.createObjectURL).not.toHaveBeenCalled()
  })

  it('fails explicitly when native pitch preservation is unsupported', async () => {
    const { ctx, sources } = makeCtx()
    ctx.state = 'running'
    const media = mockMedia({ supported: false })
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer())
    expect(await engine.setRate(0.75)).toBe(false)
    expect(engine.rate).toBe(1)
    await engine.play()
    expect(sources[0].playbackRate.value).toBe(1)
    expect(media.createObjectURL).not.toHaveBeenCalled()
    engine.pause()
  })

  it('resets the rate and releases old media resources on a new load', async () => {
    const { ctx, mediaSources } = makeCtx()
    const media = mockMedia()
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer())
    expect(await engine.setRate(1.5)).toBe(true)
    engine.seek(3)
    await engine.load(pcmBuffer(9))
    expect(engine.rate).toBe(1)
    expect(engine.time).toBe(0)
    expect(engine.duration).toBe(9)
    expect(media.elements[0].src).toBe('')
    expect(media.revokeObjectURL).toHaveBeenCalledWith('blob:audio-1')
    expect(mediaSources[0].disconnect).toHaveBeenCalledOnce()
  })

  it.each(['pause', 'seek', 'load'] as const)('%s cancels rate preparation waiting for metadata and releases its URL', async (action) => {
    const { ctx } = makeCtx()
    const media = mockMedia({ metadata: false })
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer())
    const rate = engine.setRate(0.75)
    await vi.waitFor(() => expect(media.createObjectURL).toHaveBeenCalledOnce())
    if (action === 'load') await engine.load(pcmBuffer(9))
    else if (action === 'seek') engine.seek(3)
    else engine.pause()
    expect(await rate).toBe(false)
    expect(engine.rate).toBe(1)
    expect(engine.time).toBe(action === 'seek' ? 3 : 0)
    expect(media.revokeObjectURL).toHaveBeenCalledWith('blob:audio-1')
    media.elements[0].dispatchEvent(new Event('loadedmetadata'))
    expect(engine.playing).toBe(false)
  })

  it('only the newest rate request can complete and only connects its media', async () => {
    const { ctx, mediaSources } = makeCtx()
    const media = mockMedia({ metadata: false })
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer())
    const first = engine.setRate(0.75)
    await vi.waitFor(() => expect(media.createObjectURL).toHaveBeenCalledTimes(1))
    const latest = engine.setRate(1.25)
    await vi.waitFor(() => expect(media.createObjectURL).toHaveBeenCalledTimes(2))
    media.elements[1].readyState = 1
    media.elements[1].dispatchEvent(new Event('loadedmetadata'))
    expect(await first).toBe(false)
    expect(await latest).toBe(true)
    expect(engine.rate).toBe(1.25)
    expect(mediaSources).toHaveLength(1)
    expect(mediaSources[0].element).toBe(media.elements[1])
  })

  it('a local media decoding error keeps the old rate and releases the failed resource', async () => {
    const { ctx, mediaSources } = makeCtx()
    const media = mockMedia({ metadata: false })
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer())
    engine.seek(2)
    const prepared = engine.setRate(0.75)
    await vi.waitFor(() => expect(media.createObjectURL).toHaveBeenCalledOnce())
    media.elements[0].dispatchEvent(new Event('error'))
    expect(await prepared).toBe(false)
    expect(engine.time).toBe(2)
    expect(engine.rate).toBe(1)
    expect(mediaSources).toHaveLength(0)
    expect(media.elements[0].src).toBe('')
    expect(media.revokeObjectURL).toHaveBeenCalledWith('blob:audio-1')
  })

  it('a stalled local decoder times out and releases its URL', async () => {
    const { ctx } = makeCtx()
    const media = mockMedia({ metadata: false })
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer())
    vi.useFakeTimers()
    const prepared = engine.setRate(0.75)
    await vi.runAllTimersAsync()
    expect(await prepared).toBe(false)
    expect(engine.rate).toBe(1)
    expect(media.revokeObjectURL).toHaveBeenCalledOnce()
  })

  it('reports natural media completion once and restarts from zero on the next play', async () => {
    const callbacks = new Map<number, FrameRequestCallback>()
    let frame = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callbacks.set(++frame, callback)
      return frame
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
    const { ctx } = makeCtx()
    ctx.state = 'running'
    const media = mockMedia()
    const engine = await freshEngine(ctx)
    const ended = vi.fn()
    engine.onEnd = ended
    await engine.load(pcmBuffer())
    await engine.setRate(0.75)
    await engine.play()
    media.elements[0].currentTime = 5
    media.elements[0].ended = true
    callbacks.get(frame)?.(0)
    expect(engine.playing).toBe(false)
    expect(engine.time).toBe(5)
    expect(ended).toHaveBeenCalledOnce()
    expect(callbacks.size).toBe(0)
    expect(await engine.play()).toBe(true)
    expect(engine.time).toBe(0)
    engine.pause()
  })

  it('play uses the requested media offset and restarts after a completed song', async () => {
    const { ctx } = makeCtx()
    ctx.state = 'running'
    const media = mockMedia()
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer())
    await engine.setRate(0.5)
    expect(await engine.play(3)).toBe(true)
    expect(media.elements[0].currentTime).toBe(3)
    engine.seek(5)
    expect(engine.playing).toBe(false)
    expect(engine.time).toBe(5)
    expect(await engine.play()).toBe(true)
    expect(engine.time).toBe(0)
    engine.pause()
  })

  it('refuses playback if native pitch preservation stops accepting the rate', async () => {
    const { ctx } = makeCtx()
    ctx.state = 'running'
    const media = mockMedia()
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer())
    expect(await engine.setRate(0.75)).toBe(true)
    Object.defineProperty(media.elements[0], 'preservesPitch', { get: () => false, set: () => {} })
    expect(await engine.setRate(1.25)).toBe(false)
    expect(await engine.play()).toBe(false)
    expect(engine.playing).toBe(false)
    expect(media.elements[0].play).not.toHaveBeenCalled()
  })

  it.each([0.75, NaN])('rate %s still cancels a pending media start immediately', async (rate) => {
    const { ctx } = makeCtx()
    ctx.state = 'running'
    const media = mockMedia()
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer())
    await engine.setRate(0.75)
    let complete!: () => void
    media.elements[0].play.mockImplementation(() => {
      media.elements[0].paused = false
      return new Promise<void>((resolve) => { complete = resolve })
    })
    const started = engine.play(2)
    await engine.setRate(rate)
    expect(await started).toBe(false)
    expect(media.elements[0].paused).toBe(true)
    complete()
  })

  it('a stale media play resolution cannot pause the newer playback', async () => {
    const { ctx } = makeCtx()
    ctx.state = 'running'
    const media = mockMedia()
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer())
    await engine.setRate(0.75)
    let complete!: () => void
    media.elements[0].play.mockImplementationOnce(() => new Promise<void>((resolve) => { complete = resolve }))
    const stale = engine.play(1)
    const latest = engine.play(3)
    expect(await stale).toBe(false)
    expect(await latest).toBe(true)
    complete()
    await Promise.resolve()
    expect(engine.playing).toBe(true)
    expect(engine.time).toBe(3)
    expect(media.elements[0].paused).toBe(false)
    engine.pause()
  })

  it('seek cancels a media start waiting for AudioContext resume, before native play is requested', async () => {
    const { ctx } = makeCtx()
    const media = mockMedia()
    let resumed!: () => void
    ctx.resume.mockImplementation(() => new Promise<void>((resolve) => { resumed = resolve }))
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer())
    await engine.setRate(0.75)
    const started = engine.play(1)
    engine.seek(3)
    expect(await started).toBe(false)
    ctx.state = 'running'
    resumed()
    await Promise.resolve()
    expect(media.elements[0].play).not.toHaveBeenCalled()
    expect(engine.time).toBe(3)
    expect(engine.playing).toBe(false)
  })

  it('a playing media seek changes position without pausing or restarting the decoder', async () => {
    const { ctx, sources } = makeCtx()
    ctx.state = 'running'
    const media = mockMedia()
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer())
    await engine.setRate(0.75)
    await engine.play(1)
    const pausesBeforeSeek = media.elements[0].pause.mock.calls.length
    engine.seek(4)
    expect(engine.playing).toBe(true)
    expect(engine.time).toBe(4)
    expect(media.elements[0].playbackRate).toBe(0.75)
    expect(media.elements[0].play).toHaveBeenCalledOnce()
    expect(media.elements[0].pause).toHaveBeenCalledTimes(pausesBeforeSeek)
    expect(sources).toHaveLength(0)
    engine.pause()
  })

  it('a playing original-speed seek replaces the buffer source at the requested time', async () => {
    const { ctx, sources } = makeCtx()
    ctx.state = 'running'
    const engine = await freshEngine(ctx)
    await engine.load(BUF)
    await engine.play(1)
    ctx.currentTime = 1
    engine.seek(4)
    expect(engine.playing).toBe(true)
    expect(engine.time).toBe(4)
    expect(sources).toHaveLength(2)
    expect(sources[0].stop).toHaveBeenCalledOnce()
    expect(sources[1].start).toHaveBeenCalledWith(0, 4)
    ctx.currentTime = 1.25
    expect(engine.time).toBe(4.25)
    engine.pause()
  })

  it.each(['pause', 'seek', 'load'] as const)('%s cancels a pending media play without waiting for browser permission', async (action) => {
    const { ctx } = makeCtx()
    ctx.state = 'running'
    const media = mockMedia()
    const engine = await freshEngine(ctx)
    await engine.load(pcmBuffer())
    await engine.setRate(0.75)
    let complete!: () => void
    media.elements[0].play.mockImplementation(() => {
      media.elements[0].paused = false
      return new Promise<void>((resolve) => { complete = resolve })
    })
    const started = engine.play(2)
    await vi.waitFor(() => expect(media.elements[0].play).toHaveBeenCalledOnce())
    if (action === 'load') await engine.load(pcmBuffer(9))
    else if (action === 'seek') engine.seek(3)
    else engine.pause()
    expect(await started).toBe(false)
    complete()
    await Promise.resolve()
    expect(engine.playing).toBe(false)
    expect(engine.time).toBe(action === 'seek' ? 3 : action === 'load' ? 0 : 2)
    expect(media.elements[0].paused).toBe(true)
  })
})

describe('count-in tick lifecycle', () => {
  it('returns a disposer that cancels an interrupted scheduled tick', async () => {
    const { ctx, oscillators } = makeCtx()
    const engine = await freshEngine(ctx)
    const cancel = engine.scheduleTick(4)

    expect(cancel).toBeTypeOf('function')
    cancel()
    expect(oscillators[0].stop).toHaveBeenLastCalledWith(0)
    expect(oscillators[0].disconnect).toHaveBeenCalledOnce()
  })
})
