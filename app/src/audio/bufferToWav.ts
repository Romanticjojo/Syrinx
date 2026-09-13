/** Local PCM WAV for the browser's pitch-preserving media decoder. */
export async function bufferToWav(buffer: AudioBuffer, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted()
  const channels = buffer.numberOfChannels
  const sampleBytes = buffer.length * channels * 2
  const bytes = new ArrayBuffer(44 + sampleBytes)
  const view = new DataView(bytes)
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + sampleBytes, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, sampleBytes, true)
  const data = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i))
  // Bound each uninterrupted conversion slice, including for multichannel input.
  const framesPerChunk = Math.max(1, Math.floor(262144 / channels))
  let offset = 44
  for (let start = 0; start < buffer.length; start += framesPerChunk) {
    await yieldToUI(signal)
    const end = Math.min(start + framesPerChunk, buffer.length)
    for (let frame = start; frame < end; frame++) {
      for (let channel = 0; channel < channels; channel++) {
        const sample = Math.max(-1, Math.min(1, data[channel][frame]))
        view.setInt16(offset, sample < 0 ? sample * 32768 : sample * 32767, true)
        offset += 2
      }
    }
  }
  signal.throwIfAborted()
  return new Blob([bytes], { type: 'audio/wav' })
}

function yieldToUI(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, 0)
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}
