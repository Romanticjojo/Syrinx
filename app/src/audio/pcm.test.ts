import { describe, expect, it } from 'vitest'
import { buildRecordingWav, concatFloat32, EXPORT_RATE, resampleLinear, rmsOf } from './pcm'

describe('concatFloat32', () => {
  it('按序拼接多段', () => {
    expect(Array.from(concatFloat32([new Float32Array([1, 2]), new Float32Array([3])]))).toEqual([1, 2, 3])
  })
  it('空输入产出长度 0', () => {
    expect(concatFloat32([]).length).toBe(0)
  })
})

describe('rmsOf', () => {
  it('方均根：[0.5,-0.5,0.5,-0.5] -> 0.5', () => {
    expect(rmsOf(new Float32Array([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5)
  })
  it('全零 -> 0', () => {
    expect(rmsOf(new Float32Array(8))).toBe(0)
  })
})

describe('resampleLinear', () => {
  it('同采样率原样返回', () => {
    const src = new Float32Array([1, 2, 3])
    expect(resampleLinear(src, 48000, 48000)).toBe(src)
  })
  it('降采样 8k->4k：[0,2,4,8] -> [0,4]', () => {
    const out = resampleLinear(new Float32Array([0, 2, 4, 8]), 8000, 4000)
    expect(Array.from(out)).toEqual([0, 4])
  })
  it('升采样 4k->8k：[0,2] -> [0,1,2,2]（末端夹取保持）', () => {
    const out = resampleLinear(new Float32Array([0, 2]), 4000, 8000)
    expect(Array.from(out)).toEqual([0, 1, 2, 2])
  })
  it('空输入 -> 空输出', () => {
    expect(resampleLinear(new Float32Array(0), 48000, EXPORT_RATE).length).toBe(0)
  })
})

describe('buildRecordingWav', () => {
  it('两段 8kHz 分片拼成 32kHz 单声道 WAV：头 44 + 128 数据字节', async () => {
    const chunks = [new Float32Array(8).fill(0.5), new Float32Array(8).fill(0.5)]
    const { blob, silent } = buildRecordingWav(chunks, 8000)
    expect(silent).toBe(false)
    expect(blob.type).toBe('audio/wav')
    const ab = await blob.arrayBuffer()
    expect(ab.byteLength).toBe(44 + 64 * 2)
    const v = new DataView(ab)
    expect(v.getUint16(22, true)).toBe(1) // 单声道
    expect(v.getUint32(24, true)).toBe(EXPORT_RATE)
  })
  it('全零分片 -> silent=true（RMS 诊断标记）', () => {
    const { silent } = buildRecordingWav([new Float32Array(16)], 48000)
    expect(silent).toBe(true)
  })
})
