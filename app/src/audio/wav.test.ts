import { describe, expect, it } from 'vitest'
import { encodeWav } from './wav'

const SR = 8000

/** 双声道替身：ch0 全 0、ch1 前 3 样本 +1/-1/+0.5 其余 0 */
function makeBuffer() {
  const ch0 = new Float32Array(4)
  const ch1 = new Float32Array([1, -1, 0.5, 0])
  return { sampleRate: SR, numberOfChannels: 2, length: 4, getChannelData: (c: number) => (c === 0 ? ch0 : ch1) }
}

describe('encodeWav', () => {
  it('44 字节头 + 4 样本 ×2 声道 ×2 字节 = 60 字节，RIFF/WAVE/fmt/data 魔数齐全', async () => {
    const blob = encodeWav(makeBuffer())
    expect(blob.type).toBe('audio/wav')
    const ab = await blob.arrayBuffer()
    expect(ab.byteLength).toBe(60)
    const v = new DataView(ab)
    const str = (o: number, n: number) => String.fromCharCode(...new Uint8Array(ab, o, n))
    expect(str(0, 4)).toBe('RIFF')
    expect(v.getUint32(4, true)).toBe(36 + 16) // PCM 数据 16 字节
    expect(str(8, 4)).toBe('WAVE')
    expect(str(12, 4)).toBe('fmt ')
    expect(v.getUint16(20, true)).toBe(1) // PCM
    expect(v.getUint16(22, true)).toBe(2) // 声道
    expect(v.getUint32(24, true)).toBe(SR)
    expect(v.getUint16(34, true)).toBe(16) // 位深
    expect(str(36, 4)).toBe('data')
    expect(v.getUint32(40, true)).toBe(16)
  })

  it('样本交织写入且削幅到 int16：0->0、+1->0x7fff、-1->-0x8000、+0.5->约 0x4000', async () => {
    const ab = await encodeWav(makeBuffer()).arrayBuffer()
    const v = new DataView(ab)
    // 交织序：ch0[0], ch1[0], ch0[1], ch1[1], ch0[2], ch1[2], ch0[3], ch1[3]
    expect(v.getInt16(44, true)).toBe(0)
    expect(v.getInt16(46, true)).toBe(0x7fff)
    expect(v.getInt16(48, true)).toBe(0)
    expect(v.getInt16(50, true)).toBe(-0x8000)
    expect(v.getInt16(52, true)).toBe(0)
    expect(Math.abs(v.getInt16(54, true) - 0x4000)).toBeLessThanOrEqual(1)
  })
})
