import type { PitchPoint } from '../types'
import { PitchExtraction, type ExtractOptions, type PitchAudioBuffer } from './extract'

export interface AsyncExtractOptions extends ExtractOptions {
  /** 返回 false 时终止分析并 resolve null。 */
  shouldContinue?: () => boolean
  /** 回退路径单个计算片的时长（毫秒），默认 24。 */
  sliceMs?: number
  /** 已完成帧的比例，含静音帧；从 0 到 1 单调递增。 */
  onProgress?: (fraction: number) => void
  /** 立即取消过期分析，终止 Worker/定时器并 resolve null。 */
  signal?: AbortSignal
}

export interface ExtractWorkerRequest {
  data: Float32Array
  sampleRate: number
  options: ExtractOptions
}

export type ExtractWorkerResponse =
  | { type: 'progress'; fraction: number }
  | { type: 'complete'; points: PitchPoint[] }

/** 优先后台 Worker；不可用或加载失败时回退到可交互的分片计算。 */
export function extractPitchTrackAsync(
  buffer: PitchAudioBuffer,
  opts: AsyncExtractOptions = {},
): Promise<PitchPoint[] | null> {
  const { shouldContinue, signal, onProgress, sliceMs = 24, ...options } = opts
  const canContinue = () => !signal?.aborted && (!shouldContinue || shouldContinue())
  if (!canContinue()) return Promise.resolve(null)

  return new Promise((resolve, reject) => {
    let settled = false
    let worker: Worker | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelPoll: ReturnType<typeof setInterval> | undefined
    let lastProgress = -1
    const stopWorker = () => {
      if (worker) {
        worker.onmessage = null
        worker.onerror = null
        worker.onmessageerror = null
        worker.terminate()
        worker = null
      }
      clearInterval(cancelPoll)
      cancelPoll = undefined
    }
    const cleanup = () => {
      settled = true
      clearTimeout(timer)
      stopWorker()
      signal?.removeEventListener('abort', abort)
    }
    const finish = (points: PitchPoint[] | null) => {
      if (settled) return
      cleanup()
      resolve(points)
    }
    const fail = (error: unknown) => {
      if (settled) return
      cleanup()
      reject(error)
    }
    const abort = () => finish(null)
    const report = (fraction: number) => {
      if (settled) return
      if (!canContinue()) { abort(); return }
      if (fraction > lastProgress) {
        lastProgress = fraction
        onProgress?.(fraction)
      }
      if (!canContinue()) abort()
    }

    signal?.addEventListener('abort', abort, { once: true })
    try {
      report(0)
      if (settled) return
      const data = buffer.getChannelData(0)
      const sampleRate = buffer.sampleRate
      const runFallback = () => {
        if (settled) return
        stopWorker()
        const extraction = new PitchExtraction(data, sampleRate, options)
        const budget = Number.isFinite(sliceMs) ? Math.max(0, sliceMs) : 24
        const step = () => {
          try {
            if (settled) return
            if (!canContinue()) { abort(); return }
            // 从回调真正开始计时，并至少推进一帧，避免极短时间片一直饿死。
            const deadline = performance.now() + budget
            do { extraction.advance() } while (!extraction.done && performance.now() < deadline)
            report(extraction.progress)
            if (settled) return
            if (extraction.done) finish(extraction.points)
            else timer = setTimeout(step, 0)
          } catch (error) { fail(error) }
        }
        timer = setTimeout(step, 0)
      }

      if (typeof Worker === 'undefined') { runFallback(); return }
      try {
        worker = new Worker(new URL('./extract.worker.ts', import.meta.url), { type: 'module' })
        worker.onmessage = (event: MessageEvent<ExtractWorkerResponse>) => {
          try {
            const message = event.data
            if (message.type === 'progress') report(message.fraction)
            else if (message.type === 'complete') {
              report(1)
              if (!settled) finish(message.points)
            }
          } catch (error) { fail(error) }
        }
        worker.onerror = event => { event.preventDefault(); runFallback() }
        worker.onmessageerror = runFallback
        // 保留 shouldContinue 旧 API；AbortSignal 无需等待轮询即可终止。
        if (shouldContinue) cancelPoll = setInterval(() => {
          try { if (!canContinue()) abort() } catch (error) { fail(error) }
        }, 24)
        // 只转移副本：不得 detach AudioBuffer 持有的原始音频。
        const copy = data.slice()
        const request: ExtractWorkerRequest = { data: copy, sampleRate, options }
        worker.postMessage(request, [copy.buffer])
      } catch { runFallback() }
    } catch (error) { fail(error) }
  })
}
