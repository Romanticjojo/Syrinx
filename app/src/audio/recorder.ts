/**
 * 麦克风会话封装：getUserMedia（关闭回声消除/降噪/自动增益，保留原始
 * 音高信息供 YIN 分析）+ 两条支路，共享同一个 MediaStreamAudioSourceNode：
 * - 分析流：source -> AnalyserNode（挂主 AudioContext，与伴奏同一时钟域），
 *   getFloatTimeDomainData 逐帧喂 YIN。演奏全程保持开启，不受录音开关影响。
 * - 写入流（t_静音修复）：source -> 直采节点（AudioWorklet 优先，旧浏览器回退
 *   ScriptProcessorNode），PCM Float32 分片经 MessagePort 回主线程收集。
 *   与分析支路同源同节点--分析听得到就一定录得到；此前 MediaRecorder 写入
 *   支路在部分环境产出全静音 blob（音高图为空、下载无声），故弃用。
 *   stop() 时拼接分片、RMS 诊断（整段≈0 打 warn 并带 silent 标记）、
 *   重采样 32kHz 单声道后 encodeWav。
 *
 * 暂停/恢复/重开/丢弃语义与旧 MediaRecorder 版一致（MicSession 契约不变）。
 * stop() 定稿采集并释放音轨（共享上下文不关闭）；release() 用于中途退出，
 * 丢弃一切且不产出 blob。
 */
import { buildRecordingWav } from './pcm'

export interface RecordingResult {
  blob: Blob
  url: string
  mime: string
  /** 整段 RMS 接近 0（疑似麦克风静音）的诊断标记，上层可提示 */
  silent: boolean
}

export interface MicSession {
  /** 实时分析节点（fftSize=2048），演奏页 rAF 循环逐帧读取喂 YIN */
  analyser: AnalyserNode
  /** 采样率（YIN 需要，与主上下文一致） */
  sampleRate(): number
  /** 取当前分析帧（复用同一 Float32Array，调用方当帧用完即弃） */
  readFrame(): Float32Array
  /** 丢弃当前段并立即重开一段新采集 */
  restartCapture(): Promise<void>
  /** 暂停写入（音轨与分析流保持开启），对齐伴奏暂停 */
  pauseCapture(): Promise<void>
  /** 继续写入 */
  resumeCapture(): Promise<void>
  /** 丢弃当前段，写入流关闭 */
  discardCapture(): Promise<void>
  /** 封存当前段但保持麦克风、分析支路与写入节点可继续使用。 */
  finishCapture(): Promise<RecordingResult | null>
  /** 定稿采集、释放音轨并返回整段 blob 与可回放 ObjectURL（调用方负责 revoke） */
  stop: () => Promise<RecordingResult | null>
  /** 中途退出：丢弃一切并释放音轨，不产出 blob */
  release(): void
}

/** AudioWorklet 处理器源码（内联字符串 + Blob URL 注册，避免打包器路径问题）。
 *  主线程 gate 消息控制写入开关；分片回传带段 id，旧段在途分片在主线程作废。 */
const WORKLET_SRC = `
class MicTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.gateOn = false
    this.id = -1
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'gate') {
        this.gateOn = e.data.on
        this.id = e.data.id
        this.port.postMessage({ type: 'gate-ack', on: this.gateOn, id: this.id })
      }
    }
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && this.gateOn) {
      const copy = new Float32Array(ch)
      this.port.postMessage({ id: this.id, pcm: copy }, [copy.buffer])
    }
    return true
  }
}
registerProcessor('mic-tap', MicTapProcessor)
`

/** 直采节点统一门控接口（worklet 与 fallback 同构） */
interface Tap {
  /** 开/关写入（on=false 时样本直接丢弃，等价 MediaRecorder pause 语义） */
  setGate(on: boolean, id: number): Promise<void>
  /** 断开 source 连接并释放节点 */
  dispose(): void
}

const GATE_ACK_TIMEOUT_MS = 2_000

/** 已注册过 mic-tap 模块的上下文（同上下文重复 addModule 会抛异常） */
const workletReady = new WeakSet<AudioContext>()

/** AudioWorklet 直采节点；注册失败抛异常由调用方回退 */
async function createWorkletTap(
  ctx: AudioContext,
  source: AudioNode,
  onChunk: (id: number, pcm: Float32Array) => void,
): Promise<Tap> {
  if (!workletReady.has(ctx)) {
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))
    try {
      await ctx.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    workletReady.add(ctx)
  }
  const node = new AudioWorkletNode(ctx, 'mic-tap', { numberOfInputs: 1, numberOfOutputs: 0 })
  const gateWaiters: {
    on: boolean
    id: number
    resolve: () => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }[] = []
  let disposed = false
  node.port.onmessage = (e: MessageEvent<{ type?: string; on?: boolean; id: number; pcm?: Float32Array }>) => {
    if (e.data.type === 'gate-ack') {
      const index = gateWaiters.findIndex((waiter) => waiter.id === e.data.id && waiter.on === e.data.on)
      if (index >= 0) {
        const waiter = gateWaiters.splice(index, 1)[0]
        clearTimeout(waiter.timer)
        waiter.resolve()
      }
      return
    }
    if (e.data.pcm) onChunk(e.data.id, e.data.pcm)
  }
  source.connect(node)
  return {
    setGate: (on, id) => new Promise((resolve, reject) => {
      if (disposed) {
        reject(new Error('录音写入节点已关闭'))
        return
      }
      const waiter = {
        on,
        id,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = gateWaiters.indexOf(waiter)
          if (index >= 0) gateWaiters.splice(index, 1)
          reject(new Error('录音写入确认超时'))
        }, GATE_ACK_TIMEOUT_MS),
      }
      gateWaiters.push(waiter)
      try {
        node.port.postMessage({ type: 'gate', on, id })
      } catch (error) {
        clearTimeout(waiter.timer)
        gateWaiters.splice(gateWaiters.indexOf(waiter), 1)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }),
    dispose: () => {
      if (disposed) return
      disposed = true
      for (const waiter of gateWaiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('录音写入节点已关闭'))
      }
      node.port.onmessage = null
      node.port.close()
      try {
        source.disconnect(node)
      } catch {
        // 未连接时 disconnect 抛异常，忽略
      }
      node.disconnect()
    },
  }
}

/** ScriptProcessorNode 回退：必须接 destination 才跑，经零增益接地（不外放） */
function createFallbackTap(
  ctx: AudioContext,
  source: AudioNode,
  onChunk: (id: number, pcm: Float32Array) => void,
): Tap {
  const sp = ctx.createScriptProcessor(4096, 1, 1)
  const mute = ctx.createGain()
  mute.gain.value = 0
  sp.connect(mute)
  mute.connect(ctx.destination)
  source.connect(sp)
  let gateOn = false
  let id = -1
  let disposed = false
  sp.onaudioprocess = (e) => {
    if (!gateOn) return
    onChunk(id, new Float32Array(e.inputBuffer.getChannelData(0)))
  }
  return {
    setGate: async (on, nextId) => {
      if (disposed) throw new Error('录音写入节点已关闭')
      gateOn = on
      id = nextId
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      sp.onaudioprocess = null
      try {
        source.disconnect(sp)
      } catch {
        // 未连接时 disconnect 抛异常，忽略
      }
      sp.disconnect()
      mute.disconnect()
    },
  }
}

export async function openMic(ctx: AudioContext): Promise<MicSession> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('该环境不支持麦克风采集')
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  })

  // 分析支路：挂主上下文，不连 destination（不外放）
  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  analyser.fftSize = 2048
  source.connect(analyser)
  const frameBuf = new Float32Array(analyser.fftSize)

  // 写入支路：收集当前段分片（id 作废旧段在途分片）；gate 由采集语义驱动
  let chunks: Float32Array[] = []
  let captureId = -1 // -1 = 无进行中的段
  let nextCaptureId = 0
  let gateQueue = Promise.resolve()
  let gateFailure: unknown = null
  const onChunk = (id: number, pcm: Float32Array) => {
    if (id === captureId && id >= 0) chunks.push(pcm)
  }

  // AudioWorklet 优先（无静音修复问题、主线程外采集）；注册失败回退 ScriptProcessor
  let tap: Tap
  try {
    tap = await createWorkletTap(ctx, source, onChunk)
  } catch {
    tap = createFallbackTap(ctx, source, onChunk)
  }

  let released = false
  const releaseTracks = () => {
    if (released) return
    released = true
    stream.getTracks().forEach((t) => t.stop())
  }

  const finalize = (): RecordingResult | null => {
    const collected = chunks
    chunks = []
    captureId = -1
    if (!collected.length) {
      return null
    }
    const { blob, silent } = buildRecordingWav(collected, ctx.sampleRate)
    if (silent) {
      // 诊断输出：写入支路本身有产出但电平≈0，说明输入源静音（静音表/系统输入）
      console.warn(
        `[recorder] 录音整段 RMS < 1e-4（疑似静音）：${collected.length} 分片，请检查麦克风输入`,
      )
    }
    return { blob, url: URL.createObjectURL(blob), mime: 'audio/wav', silent }
  }

  const setGate = (on: boolean, id: number) => {
    const previous = gateQueue
    const pending = previous.then(() => {
      if (gateFailure) throw gateFailure
      return tap.setGate(on, id)
    })
    gateQueue = pending.then(
      () => {},
      (error) => { gateFailure = error },
    )
    return pending
  }

  const finishCapture = async (): Promise<RecordingResult | null> => {
    const id = captureId
    if (id < 0) return null
    await setGate(false, id)
    if (captureId !== id) return null
    captureId = -1
    return finalize()
  }

  return {
    analyser,
    sampleRate: () => ctx.sampleRate,
    readFrame: () => {
      analyser.getFloatTimeDomainData(frameBuf)
      return frameBuf
    },
    async restartCapture() {
      await gateQueue
      if (gateFailure) throw gateFailure
      chunks = []
      captureId = ++nextCaptureId
      await setGate(true, captureId)
    },
    async pauseCapture() {
      if (captureId >= 0) await setGate(false, captureId)
    },
    async resumeCapture() {
      if (captureId >= 0) await setGate(true, captureId)
    },
    async discardCapture() {
      const id = captureId
      if (id >= 0) await setGate(false, id)
      if (captureId !== id) return
      chunks = []
      captureId = -1
    },
    finishCapture,
    stop: async () => {
      try {
        return await finishCapture()
      } finally {
        tap.dispose()
        releaseTracks()
      }
    },
    release() {
      tap.dispose()
      releaseTracks()
    },
  }
}
