/**
 * 麦克风会话封装：getUserMedia（关闭回声消除/降噪/自动增益，保留原始
 * 音高信息供 YIN 分析）+ 两条支路：
 * - 分析流：MediaStreamSource（挂在主 AudioContext 上，与伴奏同一时钟域，
 *   避免双上下文漂移）→ AnalyserNode，getFloatTimeDomainData 逐帧喂 YIN。
 *   演奏全程保持开启，不受录音开关影响。
 * - 写入流：MediaRecorder 分片落 blob；暂停伴奏 ⟺ 暂停写入（录制内容与
 *   伴奏时间轴严格对齐），恢复播放 ⟺ 继续写入；关掉开关 ⟺ 丢弃整段。
 *
 * stop() 定稿采集并释放音轨（共享上下文不关闭）；release() 用于中途退出，
 * 丢弃一切且不产出 blob。
 */

export interface RecordingResult {
  blob: Blob
  url: string
  mime: string
}

export interface MicSession {
  /** 实时分析节点（fftSize=2048），演奏页 rAF 循环逐帧读取喂 YIN */
  analyser: AnalyserNode
  /** 采样率（YIN 需要，与主上下文一致） */
  sampleRate(): number
  /** 取当前分析帧（复用同一 Float32Array，调用方当帧用完即弃） */
  readFrame(): Float32Array
  /** 丢弃当前段并立即重开一段新采集 */
  restartCapture(): void
  /** 暂停写入（音轨与分析流保持开启），对齐伴奏暂停 */
  pauseCapture(): void
  /** 继续写入 */
  resumeCapture(): void
  /** 丢弃当前段，写入流关闭 */
  discardCapture(): void
  /** 定稿采集、释放音轨并返回整段 blob 与可回放 ObjectURL（调用方负责 revoke） */
  stop: () => Promise<RecordingResult>
  /** 中途退出：丢弃一切并释放音轨，不产出 blob */
  release(): void
}

/** 探测当前浏览器可用的录音容器（webm 优先，Safari 回退 mp4） */
function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') throw new Error('该浏览器不支持 MediaRecorder 录音')
  return MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
}

/** 一段进行中的采集：写入器 + 累积分片 */
interface Capture {
  rec: MediaRecorder
  chunks: Blob[]
}

export async function openMic(ctx: AudioContext): Promise<MicSession> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('该环境不支持麦克风采集')
  }
  const mime = pickMime()
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

  // 写入支路
  let cap: Capture | null = null
  const makeCapture = (): Capture => {
    const rec = new MediaRecorder(stream, { mimeType: mime })
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    rec.start(250)
    return { rec, chunks }
  }
  /** 丢弃一段采集（分片引用一并作废，onstop 事件不再写入） */
  const killCapture = (c: Capture): void => {
    c.rec.ondataavailable = null
    c.rec.onerror = null
    try {
      if (c.rec.state !== 'inactive') c.rec.stop()
    } catch {
      // 已停止的写入器再 stop 会抛异常，忽略
    }
  }

  return {
    analyser,
    sampleRate: () => ctx.sampleRate,
    readFrame: () => {
      analyser.getFloatTimeDomainData(frameBuf)
      return frameBuf
    },
    restartCapture() {
      if (cap) killCapture(cap)
      cap = makeCapture()
    },
    pauseCapture() {
      if (cap && cap.rec.state === 'recording') cap.rec.pause()
    },
    resumeCapture() {
      if (cap && cap.rec.state === 'paused') cap.rec.resume()
    },
    discardCapture() {
      if (cap) killCapture(cap)
      cap = null
    },
    stop: () =>
      new Promise<RecordingResult>((resolve, reject) => {
        const releaseTracks = () => stream.getTracks().forEach((t) => t.stop())
        const finalize = (chunks: Blob[]) => {
          const blob = new Blob(chunks, { type: mime })
          resolve({ blob, url: URL.createObjectURL(blob), mime })
        }
        if (!cap || cap.rec.state === 'inactive') {
          releaseTracks()
          finalize([])
          return
        }
        const { rec, chunks } = cap
        cap = null
        rec.onerror = () => {
          releaseTracks()
          reject(new Error('录音过程出错'))
        }
        rec.onstop = () => {
          releaseTracks()
          finalize(chunks)
        }
        try {
          // 不从 paused 恢复再停：直接定稿，保留「写入关」时段不进文件的语义
          rec.stop()
        } catch (e) {
          releaseTracks()
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      }),
    release() {
      if (cap) killCapture(cap)
      cap = null
      stream.getTracks().forEach((t) => t.stop())
    },
  }
}
