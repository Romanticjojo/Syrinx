/**
 * Web Audio 唯一主时钟：
 * - AudioContext.currentTime 推导曲目时间 t，rAF 只做渲染回调
 * - play/pause/seek/setRate 均以 ctx.currentTime 为基准，不做 setInterval 计时
 * - analyser 暴露给 three.js 背景做 audio-reactive
 */
class AudioEngine {
  private ctx: AudioContext
  private src: AudioBufferSourceNode | null = null
  private gain: GainNode
  private buffer: AudioBuffer | null = null
  private startCtxTime = 0
  private startOffset = 0
  private endRaf = 0

  rate = 1
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
    this.stopSource()
    this.buffer = buffer
    this.startOffset = 0
    this.playing = false
  }

  play(offsetSec?: number): void {
    if (!this.buffer) return
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    if (offsetSec !== undefined) this.startOffset = offsetSec
    if (this.startOffset >= this.buffer.duration) this.startOffset = 0
    this.stopSource()

    const src = this.ctx.createBufferSource()
    src.buffer = this.buffer
    src.playbackRate.value = this.rate
    src.connect(this.gain)
    src.start(0, this.startOffset)
    this.src = src
    this.startCtxTime = this.ctx.currentTime
    this.playing = true
    this.watchEnd()
  }

  pause(): void {
    if (!this.playing) return
    this.startOffset = this.time
    this.stopSource()
    this.playing = false
  }

  seek(t: number): void {
    const clamped = Math.max(0, Math.min(t, this.buffer?.duration ?? 0))
    if (this.playing) {
      this.play(clamped)
    } else {
      this.startOffset = clamped
    }
  }

  /** 变速：重启 src 保住当前位置 */
  setRate(r: number): void {
    if (r <= 0 || r > 3) return
    const cur = this.time
    this.rate = r
    if (this.playing) {
      this.startOffset = cur
      this.play(cur)
    }
  }

  /** 当前曲目时间（秒）。playing 时由 ctx.currentTime 推导 */
  get time(): number {
    if (!this.playing) return this.startOffset
    return this.startOffset + (this.ctx.currentTime - this.startCtxTime) * this.rate
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
  scheduleTick(atCtxTime: number, freq = 880, dur = 0.08, vol = 0.3): void {
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
  }

  get ctxTime(): number {
    return this.ctx.currentTime
  }

  /** 恢复被浏览器自动挂起的音频上下文（用户手势里调用） */
  async resume(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume()
  }

  private stopSource(): void {
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
      if (this.buffer && this.time >= this.buffer.duration) {
        this.playing = false
        this.startOffset = this.buffer.duration
        this.onEnd?.()
        return
      }
      this.endRaf = requestAnimationFrame(check)
    }
    this.endRaf = requestAnimationFrame(check)
  }
}

export const audioEngine = new AudioEngine()
