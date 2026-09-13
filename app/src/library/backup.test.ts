import { describe, expect, it } from 'vitest'
import {
  decodeBackup,
  decodeLibraryBackup,
  encodeBackup,
  encodeBackupParts,
  encodeLibraryBackupParts,
} from './backup'
import type { LibrarySnapshot, PersonalScore, ScoreFolder } from './types'

const SHA256_A = '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd'

function score(overrides: Partial<PersonalScore> = {}): PersonalScore {
  return {
    id: 'score-a',
    fingerprint: SHA256_A,
    originalXml: 'A',
    title: '夜曲',
    composer: '肖邦',
    tags: ['练习', '浪漫派'],
    favorite: true,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_100,
    lastOpenedAt: null,
    settings: {
      melodyPartId: 'P1',
      pianoPartIds: ['P2'],
      mode: 'original',
      style: 'block',
      tonic: null,
      minor: false,
    },
    ...overrides,
  }
}

function folder(id: string, name: string): ScoreFolder {
  return { id, name, createdAt: 1_700_000_000_000 }
}

describe('个人曲库备份', () => {
  it('以版本化 JSON 往返完整记录', () => {
    const records = [score()]

    const encoded = encodeBackup(records)

    expect(JSON.parse(encoded)).toMatchObject({ schemaVersion: 1 })
    expect(decodeBackup(encoded)).toEqual(records)
  })

  it.each([
    ['非 JSON', '{'],
    ['错误版本', JSON.stringify({ schemaVersion: 2, records: [] })],
    ['多余顶层字段', JSON.stringify({ schemaVersion: 1, records: [], extra: true })],
    ['records 不是数组', JSON.stringify({ schemaVersion: 1, records: {} })],
    ['非有限时间戳', JSON.stringify({ schemaVersion: 1, records: [score({ updatedAt: null as never })] })],
    ['非法指纹', JSON.stringify({ schemaVersion: 1, records: [score({ fingerprint: 'not-a-hash' })] })],
    ['非法调式', JSON.stringify({
      schemaVersion: 1,
      records: [score({ settings: { ...score().settings, mode: 'magic' as never } })],
    })],
    ['多余记录字段', JSON.stringify({
      schemaVersion: 1,
      records: [{ ...score(), unexpected: true }],
    })],
  ])('拒绝%s且给出可理解错误', (_name, text) => {
    expect(() => decodeBackup(text)).toThrow(/备份/)
  })

  it('先验证全部记录，不返回部分结果', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      records: [score(), score({ id: 'bad', settings: { ...score().settings, tonic: 12 } })],
    })

    expect(() => decodeBackup(text)).toThrow(/备份/)
  })

  it('拒绝超过 10 MiB 的单份原谱', () => {
    const oversized = score({ originalXml: 'x'.repeat(10 * 1024 * 1024 + 1) })

    expect(() => encodeBackup([oversized])).toThrow(/10 MB/)
  })

  it('按最终 JSON 的 UTF-8 大小分卷，每份都可独立恢复且不丢记录', () => {
    const records = [1, 2, 3].map((index) => score({
      id: `score-${index}`,
      fingerprint: String(index).repeat(64),
      originalXml: `<score>${'谱"\\'.repeat(40)}</score>`,
      title: `分卷曲目 ${index}`,
    }))

    const parts = encodeBackupParts(records, 760)

    expect(parts.map((part) => part.count)).toEqual([1, 1, 1])
    expect(parts.every((part) => new TextEncoder().encode(part.text).byteLength <= 760)).toBe(true)
    expect(parts.flatMap((part) => decodeBackup(part.text))).toEqual(records)
  })

  it('空曲库仍导出一份可恢复的版本化空备份', () => {
    const parts = encodeBackupParts([])

    expect(parts).toEqual([{
      text: '{"schemaVersion":1,"records":[]}',
      count: 0,
    }])
    expect(decodeBackup(parts[0].text)).toEqual([])
  })

  it('单条记录本身超过分卷上限时明确拒绝', () => {
    expect(() => encodeBackupParts([score()], 64)).toThrow(/单份|分卷/)
  })

  it('新版解码器兼容旧 v1 备份', () => {
    const legacy = encodeBackup([score()])

    expect(decodeLibraryBackup(legacy)).toEqual({ records: [score()], folders: [] })
  })

  it('v2 分卷在每卷保留完整文件夹元数据、封面和记录顺序', () => {
    const folders = [folder('empty', '空文件夹'), folder('scores', '曲谱')]
    const records = [1, 2, 3].map((index) => score({
      id: `score-${index}`,
      fingerprint: String(index).repeat(64),
      originalXml: `<score>${'谱"\\'.repeat(40)}</score>`,
      title: `分卷曲目 ${index}`,
      folderId: 'scores',
      coverImage: index === 1 ? 'data:image/jpeg;base64,AA==' : null,
    }))
    const snapshot: LibrarySnapshot = { records, folders }

    const parts = encodeLibraryBackupParts(snapshot, 1_100)
    const decoded = parts.map((part) => decodeLibraryBackup(part.text))

    expect(parts.map((part) => part.count)).toEqual([1, 1, 1])
    expect(parts.every((part) => new TextEncoder().encode(part.text).byteLength <= 1_100)).toBe(true)
    expect(decoded.every((part) => JSON.stringify(part.folders) === JSON.stringify(folders))).toBe(true)
    expect(decoded.flatMap((part) => part.records)).toEqual(records)
    expect(decoded[0].records[0].coverImage).toBe('data:image/jpeg;base64,AA==')
  })

  it('只有空文件夹时仍生成一份可恢复的 v2 备份', () => {
    const snapshot: LibrarySnapshot = { records: [], folders: [folder('empty', '空文件夹')] }

    const parts = encodeLibraryBackupParts(snapshot)

    expect(parts).toHaveLength(1)
    expect(parts[0].count).toBe(0)
    expect(decodeLibraryBackup(parts[0].text)).toEqual(snapshot)
  })

  it('v2 解码在返回任何内容前拒绝悬空引用和非法封面', () => {
    const dangling = JSON.stringify({
      schemaVersion: 2,
      folders: [folder('folder', '文件夹')],
      records: [score({ folderId: 'missing' })],
    })
    const badCover = JSON.stringify({
      schemaVersion: 2,
      folders: [],
      records: [score({ coverImage: 'data:image/svg+xml;base64,AA==' })],
    })

    expect(() => decodeLibraryBackup(dangling)).toThrow(/文件夹/)
    expect(() => decodeLibraryBackup(badCover)).toThrow(/封面/)
  })
})
