/**
 * 演奏录音封装：getUserMedia（关闭回声消除/降噪/自动增益，
 * 保留原始音高信息供 YIN 分析）+ MediaRecorder 分片采集。
 * stop() 后释放音轨并返回 blob 与可回放 ObjectURL（调用方负责 revoke）。
 */

export interface RecordingResult {
  blob: Blob
  url: string
  mime: string
}

export interface Recorder {
  stop: () => Promise<RecordingResult>
}

/** 探测当前浏览器可用的录音容器（webm 优先，Safari 回退 mp4） */
function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') throw new Error('该浏览器不支持 MediaRecorder 录音')
  return MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4'
}

export async function startRecording(): Promise<Recorder> {
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
  const rec = new MediaRecorder(stream, { mimeType: mime })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }
  rec.start(250)

  return {
    stop: () =>
      new Promise<RecordingResult>((resolve, reject) => {
        rec.onerror = () => reject(new Error('录音过程出错'))
        rec.onstop = () => {
          stream.getTracks().forEach((t) => t.stop())
          const blob = new Blob(chunks, { type: mime })
          resolve({ blob, url: URL.createObjectURL(blob), mime })
        }
        try {
          rec.stop()
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
        }
      }),
  }
}
