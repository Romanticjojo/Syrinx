import { describe, expect, it } from 'vitest'
import { coverDimensions, inspectCoverBytes, readCoverFile, validateCoverInput } from './cover'

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width); view.setUint32(20, height)
  return bytes
}

describe('本地封面输入边界', () => {
  it('拒绝空文件和超过 10 MiB 的文件，允许恰好上限', () => {
    expect(() => validateCoverInput({ name: 'cover.png', type: 'image/png', size: 0 })).toThrow(/大小/)
    expect(() => validateCoverInput({ name: 'cover.png', type: 'image/png', size: 10 * 1024 * 1024 + 1 })).toThrow(/10/)
    expect(() => validateCoverInput({ name: 'cover.PNG', type: '', size: 10 * 1024 * 1024 })).not.toThrow()
  })
  it('拒绝 SVG、远端地址和伪装的非图片 MIME', () => {
    for (const input of [
      { name: 'cover.svg', type: 'image/svg+xml', size: 100 },
      { name: 'cover.png', type: 'text/html', size: 100 },
      { name: 'https://example.com/cover.png', type: 'image/png', size: 100 },
    ]) expect(() => validateCoverInput(input)).toThrow(/PNG|JPEG|WebP/)
  })
  it('按真实文件头识别 PNG，而不是相信扩展名', () => {
    expect(inspectCoverBytes(png(1200, 800))).toEqual({ mime: 'image/png', width: 1200, height: 800 })
    expect(() => inspectCoverBytes(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toThrow(/PNG|JPEG|WebP/)
    expect(() => inspectCoverBytes(png(1, 1).slice(0, 20))).toThrow(/损坏/)
  })
  it('识别 JPEG SOF 中的真实像素尺寸', () => {
    const jpeg = new Uint8Array([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 11, 8, 3, 32, 4, 176, 1, 1, 17, 0, 255, 217])
    expect(inspectCoverBytes(jpeg)).toEqual({ mime: 'image/jpeg', width: 1200, height: 800 })
    expect(() => inspectCoverBytes(jpeg.slice(0, 14))).toThrow(/损坏/)
  })
  it('识别三种 WebP 文件头，并拒绝容器截断', () => {
    const webp = (kind: string, payload: number[]) => {
      const bytes = new Uint8Array(20 + payload.length + payload.length % 2)
      bytes.set(new TextEncoder().encode('RIFF'), 0)
      bytes.set(new TextEncoder().encode('WEBP' + kind), 8)
      const view = new DataView(bytes.buffer)
      view.setUint32(4, bytes.length - 8, true); view.setUint32(16, payload.length, true)
      bytes.set(payload, 20)
      return bytes
    }
    for (const bytes of [
      webp('VP8X', [0, 0, 0, 0, 175, 4, 0, 31, 3, 0]),
      webp('VP8 ', [0, 0, 0, 157, 1, 42, 176, 4, 32, 3]),
      webp('VP8L', [47, 175, 196, 199, 0]),
    ]) {
      expect(inspectCoverBytes(bytes)).toEqual({ mime: 'image/webp', width: 1200, height: 800 })
      expect(() => inspectCoverBytes(bytes.slice(0, -1))).toThrow(/损坏/)
    }
  })
  it('已取消的操作不读取或解码输入', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(readCoverFile(new File(['x'], 'image.svg', { type: 'image/svg+xml' }), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
  it('在解码前拒绝超出 24 MP 或零尺寸的图片', () => {
    expect(() => inspectCoverBytes(png(6000, 4001))).toThrow(/2400/)
    expect(() => inspectCoverBytes(png(0, 100))).toThrow(/尺寸/)
    expect(inspectCoverBytes(png(6000, 4000)).width).toBe(6000)
  })
  it('最长边不超过 800，保持纵横比且不放大小图', () => {
    expect(coverDimensions(2400, 1600)).toEqual({ width: 800, height: 533 })
    expect(coverDimensions(1200, 2400)).toEqual({ width: 400, height: 800 })
    expect(coverDimensions(200, 300)).toEqual({ width: 200, height: 300 })
    for (const [width, height] of [[NaN, 1], [1, 0], [1.5, 4], [6001, 4000]]) expect(() => coverDimensions(width, height)).toThrow()
  })
})
