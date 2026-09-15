import { bufferToWav } from './bufferToWav'

interface MediaTransport {
  element: HTMLAudioElement
  node: MediaElementAudioSourceNode
  url: string
}

/** 原速使用 Web Audio 时钟；变速使用保调媒体的真实 currentTime。 */
class AudioEngine {
  private ctx: AudioContext
  private src: AudioBufferSourceNode | null = null
  private gain: GainNode
  private buffer: AudioBuffer | null = null
  private startCtxTime = 0
  private startOffset = 0
  private endRaf = 0
  private operation = new AbortController()
  private media: MediaTransport | null = null
  private mediaPlayOperation: AbortSignal | null = null
  private playbackRate = 1

  playing = false
  onEnd?: () => void

  /** 给 three.js 背景做频谱反应 */
  analyser: AnalyserNode

  constructor() {
    this.ctx = new AudioContext()
    this.gain = this.ctx.createGain()
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 256
    this.gain.connect(this.analyser)
    this.analyser.connect(this.ctx.destination)
  }

  async load(buffer: AudioBuffer): Promise<void> {
    this.pause()
    if (this.media) this.releaseMedia(this.media)
    this.media = null
    this.buffer = buffer
    this.startOffset = 0
    this.playbackRate = 1
  }

  /** 播放（可选起点秒）。
   *  必须先 await resume 再 start：浏览器自动播放策略下 ctx suspended 时
   *  fire-and-forget 的 resume 会让 src.start() 先于恢复执行 -> 静音。
   *  resume 失败（仍 suspended）返回 false 且不置 playing，调用方据此提示。
   *  等待恢复期间 pause/load/seek 或新的 play 会撤销旧请求。 */
  async play(offsetSec?: number): Promise<boolean> {
    const offset = this.clampTime(offsetSec ?? this.time)
    const signal = this.beginOperation()
    this.stopSource()
    this.playing = false
    this.startOffset = offset >= this.duration ? 0 : offset
    return this.startPlayback(signal)
  }

  private async startPlayback(signal: AbortSignal): Promise<boolean> {
    const buffer = this.buffer
    if (!buffer || signal.aborted) return false
    if (this.ctx.state === 'suspended') {
      try {
        await this.awaitActive(this.ctx.resume(), signal)
      } catch (e: unknown) {
        if (!signal.aborted) console.warn(`[audio] AudioContext resume 失败（保持 suspended）：${e instanceof Error ? e.message : e}`)
        return false
      }
    }
    if (signal.aborted || this.ctx.state !== 'running') return false

    if (this.media) {
      const media = this.media
      this.mediaPlayOperation = signal
      const cancelPlay = () => media.element.pause()
      signal.addEventListener('abort', cancelPlay, { once: true })
      try {
        this.configureRate(media.element, this.rate)
        media.element.currentTime = this.startOffset
        // pause() normally rejects a pending browser play. Also guard a late
        // resolution, without stopping a newer play using the same element.
        const started = media.element.play().then(() => {
          if (signal.aborted && (this.media !== media || this.mediaPlayOperation === signal)) media.element.pause()
        })
        await this.awaitActive(started, signal)
      } catch {
        if (!signal.aborted) media.element.pause()
        return false
      } finally {
        signal.removeEventListener('abort', cancelPlay)
      }
      if (signal.aborted) return false
    } else {
      const src = this.ctx.createBufferSource()
      src.buffer = buffer
      // Never change BufferSource rate: that transposes the accompaniment.
      src.connect(this.gain)
      src.start(0, this.startOffset)
      this.src = src
      this.startCtxTime = this.ctx.currentTime
    }

    this.playing = true
    this.watchEnd()
    return true
  }

  /** AudioContext 状态（running/suspended/closed），UI 音频徽标用 */
  get state(): AudioContextState {
    return this.ctx.state
  }

  pause(): void {
    const offset = this.time
    this.beginOperation()
    this.startOffset = offset
    this.stopSource()
    this.playing = false
  }

  seek(t: number): void {
    const clamped = this.clampTime(t)
    if (this.playing && clamped < this.duration) {
      if (this.media) {
        // Replay alignment must not restart an already-running media decoder.
        this.beginOperation()
        this.startOffset = clamped
        this.media.element.currentTime = clamped
      } else {
        void this.play(clamped)
      }
    } else {
      this.pause()
      this.startOffset = clamped
      if (this.media) this.media.element.currentTime = clamped
    }
  }

  /** 保持音高与原曲时间；准备失败或被新操作取消时返回 false。 */
  async setRate(r: number): Promise<boolean> {
    const signal = this.beginOperation()
    if (!Number.isFinite(r) || r < 0.5 || r > 1.5 || !this.buffer) return false
    if (r === this.rate) return true
    const offset = this.time
    const wasPlaying = this.playing
    this.stopSource()
    this.playing = false
    this.startOffset = offset
    let prepared: MediaTransport | null = null
    try {
      const media = this.media ?? (prepared = await this.prepareMedia(this.buffer, signal))
      signal.throwIfAborted()
      this.configureRate(media.element, r)
      media.element.currentTime = offset
      this.media = media
      this.playbackRate = r
      return wasPlaying ? await this.startPlayback(signal) : true
    } catch (error: unknown) {
      if (prepared && this.media !== prepared) this.releaseMedia(prepared)
      if (!signal.aborted) console.warn(`[audio] 保调变速失败：${error instanceof Error ? error.message : error}`)
      return false
    }
  }

  get rate(): number {
    return this.playbackRate
  }

  /** 原曲秒数。暂停保留精确定位；播放跟随真实时钟，不用墙上时间估算。 */
  get time(): number {
    if (!this.playing) return this.startOffset
    // Native seek times may round below the requested boundary. That must not
    // move the score or a new capture into the previous measure, even on play.
    if (this.media) return Math.max(this.startOffset, this.clampTime(this.media.element.currentTime))
    return this.clampTime(this.startOffset + (this.ctx.currentTime - this.startCtxTime))
  }

  get duration(): number {
    return this.buffer?.duration ?? 0
  }

  getVolume(): number {
    return this.gain.gain.value
  }

  setVolume(v: number): void {
    this.gain.gain.value = Math.max(0, Math.min(1, v))
  }

  /** 调度倒数节拍音（短促 sine tick），与主时钟同源 */
  scheduleTick(atCtxTime: number, freq = 880, dur = 0.08, vol = 0.3): () => void {
    const osc = this.ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = freq
    const g = this.ctx.createGain()
    g.gain.setValueAtTime(vol, atCtxTime)
    g.gain.exponentialRampToValueAtTime(0.0001, atCtxTime + dur)
    osc.connect(g)
    g.connect(this.ctx.destination)
    osc.start(atCtxTime)
    osc.stop(atCtxTime + dur + 0.02)
    let cancelled = false
    return () => {
      if (cancelled) return
      cancelled = true
      try {
        osc.stop(this.ctx.currentTime)
      } catch {
        // The scheduled oscillator may already have ended.
      }
      osc.disconnect()
      g.disconnect()
    }
  }

  get ctxTime(): number {
    return this.ctx.currentTime
  }

  /** 麦克风分析支路挂载点：与主时钟/伴奏同一 AudioContext，避免双上下文漂移 */
  get audioCtx(): AudioContext {
    return this.ctx
  }

  /** 恢复被浏览器自动挂起的音频上下文（用户手势里调用） */
  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume()
  }

  /** 解码音频数据（录音 → AudioBuffer 供音高分析） */
  async decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data)
  }

  private stopSource(): void {
    this.media?.element.pause()
    if (this.endRaf) {
      cancelAnimationFrame(this.endRaf)
      this.endRaf = 0
    }
    if (this.src) {
      this.src.onended = null
      try {
        this.src.stop()
      } catch {
        // 已停止的 src 调 stop 会抛异常，忽略
      }
      this.src.disconnect()
      this.src = null
    }
  }

  /** rAF 轮询结束（比 onended 稳，seek 重启不误触发） */
  private watchEnd(): void {
    const check = () => {
      if (!this.playing) return
      if (this.buffer && (this.media?.element.ended || this.time >= this.buffer.duration)) {
        this.stopSource()
        this.playing = false
        this.startOffset = this.buffer.duration
        this.onEnd?.()
        return
      }
      this.endRaf = requestAnimationFrame(check)
    }
    this.endRaf = requestAnimationFrame(check)
  }

  private clampTime(time: number): number {
    return Number.isFinite(time) ? Math.max(0, Math.min(time, this.duration)) : 0
  }

  private configureRate(element: HTMLAudioElement, rate: number): void {
    element.preservesPitch = true
    element.playbackRate = rate
    if (!element.preservesPitch || element.playbackRate !== rate) throw new Error('Pitch-preserving playback is unsupported')
  }

  private beginOperation(): AbortSignal {
    this.operation.abort()
    this.operation = new AbortController()
    return this.operation.signal
  }

  private awaitActive<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      promise.then(
        (value) => { signal.removeEventListener('abort', abort); resolve(value) },
        (error: unknown) => { signal.removeEventListener('abort', abort); reject(error) },
      )
      if (signal.aborted) abort()
    })
  }

  private async prepareMedia(buffer: AudioBuffer, signal: AbortSignal): Promise<MediaTransport> {
    const element = new Audio()
    if (!('preservesPitch' in element) || typeof this.ctx.createMediaElementSource !== 'function') {
      throw new Error('Pitch-preserving playback is unsupported')
    }
    element.preservesPitch = true
    if (!element.preservesPitch) throw new Error('Pitch-preserving playback is unsupported')
    const blob = await bufferToWav(buffer, signal)
    signal.throwIfAborted()
    const url = URL.createObjectURL(blob)
    let node: MediaElementAudioSourceNode | undefined
    try {
      element.preload = 'auto'
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout)
          element.removeEventListener('loadedmetadata', loaded)
          element.removeEventListener('error', failed)
          signal.removeEventListener('abort', aborted)
        }
        const loaded = () => { cleanup(); resolve() }
        const failed = () => { cleanup(); reject(new Error('Unable to load the local accompaniment WAV')) }
        const aborted = () => { cleanup(); reject(signal.reason) }
        const timeout = setTimeout(failed, 15000)
        element.addEventListener('loadedmetadata', loaded)
        element.addEventListener('error', failed)
        signal.addEventListener('abort', aborted, { once: true })
        element.src = url
        element.load()
        if (element.readyState >= 1) loaded()
        if (signal.aborted) aborted()
      })
      signal.throwIfAborted()
      node = this.ctx.createMediaElementSource(element)
      node.connect(this.gain)
      return { element, node, url }
    } catch (error: unknown) {
      element.pause()
      element.removeAttribute('src')
      element.load()
      node?.disconnect()
      URL.revokeObjectURL(url)
      throw error
    }
  }

  private releaseMedia(media: MediaTransport): void {
    media.element.pause()
    media.node.disconnect()
    media.element.removeAttribute('src')
    media.element.load()
    URL.revokeObjectURL(media.url)
  }
}

export const audioEngine = new AudioEngine()
