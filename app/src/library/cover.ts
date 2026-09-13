const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_PIXELS = 24_000_000
const MAX_COVER_BYTES = 512 * 1024
const TARGET_BYTES = 256 * 1024
type CoverMime = 'image/png' | 'image/jpeg' | 'image/webp'

export function validateCoverInput(file: Pick<File, 'name' | 'type' | 'size'>): void {
  if (!/\.(png|jpe?g|webp)$/i.test(file.name) || /[\\/:]/.test(file.name)
    || (file.type !== '' && !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) {
    throw new Error('封面请选择本机的 PNG、JPEG 或 WebP 图片。')
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > MAX_FILE_BYTES) {
    throw new Error('封面文件大小须大于零且不超过 10 MiB。')
  }
}

/** Also checked after decoding; header inspection prevents oversized raster allocation. */
export function coverDimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error('图片尺寸无效，请重新导出图片。')
  }
  if (width * height > MAX_PIXELS) throw new Error('图片超过 2400 万像素，请先缩小后再选择。')
  const scale = Math.min(1, 800 / Math.max(width, height))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

export function inspectCoverBytes(bytes: Uint8Array): { mime: CoverMime; width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const damaged = (): never => { throw new Error('图片文件损坏或格式不完整，请重新导出图片。') }
  const text = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length))
  const result = (mime: CoverMime, width: number, height: number) => {
    coverDimensions(width, height)
    return { mime, width, height }
  }
  if (bytes[0] === 137 && text(1, 3) === 'PNG') {
    if (bytes.length < 33 || text(4, 4) !== '\r\n\x1a\n' || text(12, 4) !== 'IHDR' || view.getUint32(8) !== 13) damaged()
    return result('image/png', view.getUint32(16), view.getUint32(20))
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2
    while (offset < bytes.length) {
      if (bytes[offset++] !== 255) damaged()
      while (bytes[offset] === 255) offset++
      const marker = bytes[offset++]
      if (marker === undefined || marker === 217 || marker === 218) damaged()
      if (marker === 1 || marker >= 208 && marker <= 215) continue
      if (offset + 2 > bytes.length) damaged()
      const length = view.getUint16(offset)
      if (length < 2 || offset + length > bytes.length) damaged()
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) damaged()
        return result('image/jpeg', view.getUint16(offset + 5), view.getUint16(offset + 3))
      }
      offset += length
    }
    return damaged()
  }
  if (text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    if (bytes.length < 20 || view.getUint32(4, true) + 8 !== bytes.length) damaged()
    const little24 = (at: number) => bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16
    let offset = 12
    while (offset + 8 <= bytes.length) {
      const kind = text(offset, 4), size = view.getUint32(offset + 4, true), start = offset + 8
      if (start + size > bytes.length) damaged()
      if (kind === 'VP8X') {
        if (size < 10) damaged()
        return result('image/webp', little24(start + 4) + 1, little24(start + 7) + 1)
      }
      if (kind === 'VP8L') {
        if (size < 5 || bytes[start] !== 47) damaged()
        return result('image/webp', (bytes[start + 1] | (bytes[start + 2] & 63) << 8) + 1,
          ((bytes[start + 2] >> 6) | bytes[start + 3] << 2 | (bytes[start + 4] & 15) << 10) + 1)
      }
      if (kind === 'VP8 ') {
        if (size < 10 || text(start + 3, 3) !== '\x9d\x01\x2a') damaged()
        return result('image/webp', view.getUint16(start + 6, true) & 16383, view.getUint16(start + 8, true) & 16383)
      }
      offset = start + size + (size % 2)
    }
    return damaged()
  }
  throw new Error('图片内容不是受支持的 PNG、JPEG 或 WebP，不能使用 SVG 或其他格式。')
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('封面处理已取消', 'AbortError')
}

function decodeImage(blob: Blob, signal?: AbortSignal): Promise<HTMLImageElement> {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    const image = new Image()
    const url = URL.createObjectURL(blob)
    const cleanup = () => {
      image.onload = null; image.onerror = null
      signal?.removeEventListener('abort', onAbort)
      URL.revokeObjectURL(url)
    }
    const onAbort = () => { cleanup(); image.removeAttribute('src'); reject(new DOMException('封面处理已取消', 'AbortError')) }
    image.onload = () => { cleanup(); resolve(image) }
    image.onerror = () => { cleanup(); reject(new Error('无法打开这张图片，请重新导出为 PNG、JPEG 或 WebP。')) }
    signal?.addEventListener('abort', onAbort, { once: true })
    image.src = url
  })
}

function toDataUrl(blob: Blob, signal?: AbortSignal): Promise<string> {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const cleanup = () => { signal?.removeEventListener('abort', onAbort); reader.onload = null; reader.onerror = null; reader.onabort = null }
    const onAbort = () => { reader.abort(); cleanup(); reject(new DOMException('封面处理已取消', 'AbortError')) }
    reader.onload = () => { cleanup(); resolve(String(reader.result)) }
    reader.onerror = () => { cleanup(); reject(new Error('无法保存封面图片，请重试。')) }
    signal?.addEventListener('abort', onAbort, { once: true })
    reader.readAsDataURL(blob)
  })
}

/** Local, re-encoded raster only. Returned data URL is safe to store, never a Blob URL. */
export async function readCoverFile(file: File, signal?: AbortSignal): Promise<string> {
  checkAbort(signal); validateCoverInput(file)
  const bytes = new Uint8Array(await file.arrayBuffer())
  checkAbort(signal)
  const header = inspectCoverBytes(bytes)
  const image = await decodeImage(new Blob([bytes], { type: header.mime }), signal)
  const canvas = document.createElement('canvas')
  try {
    checkAbort(signal)
    const dimensions = coverDimensions(image.naturalWidth, image.naturalHeight)
    canvas.width = dimensions.width; canvas.height = dimensions.height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('此设备暂时无法处理图片，请稍后重试。')
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    let best: Blob | null = null
    for (const type of ['image/webp', 'image/jpeg']) {
      if (type === 'image/jpeg') {
        context.globalCompositeOperation = 'destination-over'
        context.fillStyle = '#161818'; context.fillRect(0, 0, canvas.width, canvas.height)
        context.globalCompositeOperation = 'source-over'
      }
      for (const quality of [.86, .72, .55, .35]) {
        checkAbort(signal)
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
        checkAbort(signal)
        if (!blob || blob.type !== type) break
        if (!best || blob.size < best.size) best = blob
        if (blob.size <= TARGET_BYTES) return await toDataUrl(blob, signal)
      }
      if (best && best.size <= MAX_COVER_BYTES) return await toDataUrl(best, signal)
    }
    throw new Error('图片压缩后仍超过 512 KiB，请选择更简单或更小的封面。')
  } finally {
    image.removeAttribute('src')
    canvas.width = 1; canvas.height = 1
  }
}
