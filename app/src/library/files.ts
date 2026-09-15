import { Inflate } from 'fflate'
import { MAX_XML_BYTES, parseXml } from './score-parse'

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024
const failure = (s: string): never => { throw new Error(s) }
const safePath = (path: string) => {
  if (!path || path.length > 1024 || /[\\:]/.test(path) || [...path].some(c => c.charCodeAt(0) < 32) || path.startsWith('/') || path.split('/').some(p => p === '..' || p === '.')) failure('MXL 包含不安全的文件路径')
  return path
}
const decode = (bytes: Uint8Array) => {
  try {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8'
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch { return failure('XML 文本编码无效，请导出为 UTF-8 或 UTF-16') }
}
const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; return c >>> 0 })

async function unzipBounded(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = bytes.length - 22
  while (end >= Math.max(0, bytes.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--
  if (end < 0 || end < bytes.length - 65557) failure('MXL/ZIP 文件不完整')
  const count = view.getUint16(end + 10, true), directorySize = view.getUint32(end + 12, true), offset = view.getUint32(end + 16, true)
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || view.getUint16(end + 8, true) !== count || offset + directorySize !== end || end + 22 + view.getUint16(end + 20, true) !== bytes.length) failure('不支持此 MXL/ZIP 格式（分卷或 ZIP64）')
  if (count > 128) failure('MXL 文件数量超过 128')
  const entries: { name: string; size: number; compressed: number; method: number; local: number; crc: number }[] = []
  let cursor = offset, total = 0
  const names = new Set<string>()
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) failure('MXL/ZIP 索引损坏')
    const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true), crc = view.getUint32(cursor + 16, true), compressed = view.getUint32(cursor + 20, true), size = view.getUint32(cursor + 24, true)
    const nameLength = view.getUint16(cursor + 28, true), extra = view.getUint16(cursor + 30, true), comment = view.getUint16(cursor + 32, true), local = view.getUint32(cursor + 42, true)
    if (cursor + 46 + nameLength + extra + comment > end) failure('MXL/ZIP 文件索引越界')
    const name = safePath(decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)))
    if (names.has(name)) failure('MXL 中存在重复路径')
    names.add(name)
    if (flags & 1 || method !== 0 && method !== 8) failure('MXL 加密或压缩方式不支持')
    if (size > MAX_XML_BYTES || (total += size) > MAX_EXPANDED_BYTES) failure('MXL 解压大小超限：单文件 10 MiB，总量 32 MiB')
    if (compressed > bytes.length || local + 30 > offset) failure('MXL/ZIP 数据位置无效')
    entries.push({ name, size, compressed, method, local, crc })
    cursor += 46 + nameLength + extra + comment
  }
  if (cursor !== end) failure('MXL/ZIP 索引长度无效')
  const output = new Map<string, Uint8Array>()
  let actualTotal = 0
  for (const entry of entries) {
    const { local, name, size, compressed, method } = entry
    if (view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 8, true) !== method || view.getUint16(local + 6, true) & 1) failure('MXL/ZIP 文件头损坏')
    const nameLength = view.getUint16(local + 26, true), extraLength = view.getUint16(local + 28, true)
    const start = local + 30 + nameLength + extraLength
    if (start + compressed > offset || decode(bytes.subarray(local + 30, local + 30 + nameLength)) !== name) failure('MXL/ZIP 文件路径或数据不一致')
    const result = new Uint8Array(size)
    let written = 0, crc = 0xffffffff
    const receive = (chunk: Uint8Array) => {
      written += chunk.length; actualTotal += chunk.length
      if (written > size || actualTotal > MAX_EXPANDED_BYTES) failure('MXL 实际解压大小超过限制')
      result.set(chunk, written - chunk.length)
      for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8
    }
    if (method === 0) receive(bytes.subarray(start, start + compressed))
    else {
      const inflater = new Inflate(receive)
      for (let pos = 0; pos < compressed; pos += 4096) {
        inflater.push(bytes.subarray(start + pos, start + Math.min(compressed, pos + 4096)), pos + 4096 >= compressed)
        if (pos % 65536 === 0) await new Promise(resolve => setTimeout(resolve, 0))
      }
    }
    if (written !== size || ((crc ^ 0xffffffff) >>> 0) !== entry.crc) failure('MXL/ZIP 校验失败，文件可能已损坏')
    output.set(name, result)
  }
  return output
}

export async function readScoreFile(file: File): Promise<string> {
  if (!/\.(musicxml|xml|mxl)$/i.test(file.name)) failure('请选择 MusicXML、XML 或 MXL 文件')
  const compressed = /\.mxl$/i.test(file.name)
  if (!file.size || file.size > (compressed ? MAX_ARCHIVE_BYTES : MAX_XML_BYTES)) failure(compressed ? 'MXL 文件大小须为 1 字节至 20 MiB' : 'XML 文件大小须为 1 字节至 10 MiB')
  const bytes = new Uint8Array(await file.arrayBuffer())
  let xml: string
  if (compressed) {
    let archive: Map<string, Uint8Array>
    try { archive = await unzipBounded(bytes) } catch (e) { throw new Error(`MXL 解压失败：${e instanceof Error ? e.message : 'ZIP 文件损坏'}`) }
    const container = archive.get('META-INF/container.xml')
    if (!container) failure('MXL 缺少 META-INF/container.xml')
    const doc = parseXml(decode(container!))
    if (doc.documentElement.localName !== 'container') failure('MXL container.xml 格式无效')
    const roots = [...doc.getElementsByTagName('rootfile')]
    const root = roots.find(e => e.getAttribute('media-type') === 'application/vnd.recordare.musicxml+xml') || roots.find(e => !e.getAttribute('media-type'))
    const path = safePath(root?.getAttribute('full-path') || '')
    const score = archive.get(path)
    if (!score) failure('MXL container 指向的乐谱不存在')
    xml = decode(score!)
  } else xml = decode(bytes)
  if (parseXml(xml).documentElement.localName !== 'score-partwise') failure('仅支持 score-partwise MusicXML')
  return xml
}
