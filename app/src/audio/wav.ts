/**
 * WAV（16-bit PCM）编码器：下载导出用。
 * MediaRecorder 的 webm blob 缺 Duration 元数据（Chrome 已知问题），
 * 下载后在部分播放器无声/0:00；解码后重编码为 WAV 可全兼容播放。
 * 输入为 AudioBuffer 鸭子类型，测试替身可直接传入。
 */
export interface WavBuffer {
  sampleRate: number
  numberOfChannels: number
  length: number
  getChannelData(channel: number): Float32Array
}

export function encodeWav(buffer: WavBuffer): Blob {
  const { sampleRate: sr, numberOfChannels: ch, length } = buffer
  const dataBytes = length * ch * 2
  const ab = new ArrayBuffer(44 + dataBytes)
  const v = new DataView(ab)
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i))
  }
  str(0, 'RIFF')
  v.setUint32(4, 36 + dataBytes, true)
  str(8, 'WAVE')
  str(12, 'fmt ')
  v.setUint32(16, 16, true) // fmt 块长
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, ch, true)
  v.setUint32(24, sr, true)
  v.setUint32(28, sr * ch * 2, true) // byte rate
  v.setUint16(32, ch * 2, true) // block align
  v.setUint16(34, 16, true) // bits per sample
  str(36, 'data')
  v.setUint32(40, dataBytes, true)
  const chans: Float32Array[] = []
  for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c))
  let off = 44
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, chans[c]![i] ?? 0))
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      off += 2
    }
  }
  return new Blob([ab], { type: 'audio/wav' })
}
