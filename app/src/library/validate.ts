import type { LibrarySnapshot, PersonalScore, ScoreFolder, ScoreSettings } from './types'

export const MAX_SCORE_XML_BYTES = 10 * 1024 * 1024
export const MAX_BACKUP_BYTES = 100 * 1024 * 1024
export const MAX_BACKUP_RECORDS = 5_000
export const MAX_FOLDERS = 1_000
export const MAX_COVER_BYTES = 512 * 1024

const REQUIRED_RECORD_KEYS = [
  'id',
  'fingerprint',
  'originalXml',
  'title',
  'composer',
  'tags',
  'favorite',
  'createdAt',
  'updatedAt',
  'lastOpenedAt',
  'settings',
] as const
const OPTIONAL_RECORD_KEYS = ['folderId', 'coverImage'] as const

const SETTINGS_KEYS = [
  'melodyPartId',
  'pianoPartIds',
  'mode',
  'style',
  'tonic',
  'minor',
] as const
const FOLDER_KEYS = ['id', 'name', 'createdAt'] as const
const SNAPSHOT_KEYS = ['records', 'folders'] as const

const encoder = new TextEncoder()

function fail(context: string, reason: string): never {
  throw new Error(`${context}无效：${reason}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function hasRecordKeys(value: Record<string, unknown>): boolean {
  const allowed = new Set<string>([...REQUIRED_RECORD_KEYS, ...OPTIONAL_RECORD_KEYS])
  return REQUIRED_RECORD_KEYS.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => allowed.has(key))
}

function boundedString(
  value: unknown,
  field: string,
  context: string,
  maxLength: number,
  allowEmpty = false,
): string {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && value.trim().length === 0)) {
    fail(context, `${field}格式不正确`)
  }
  return value
}

function timestamp(value: unknown, field: string, context: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(context, `${field}必须是有效的毫秒时间戳`)
  }
  return value
}

function validateSettings(value: unknown, context: string): ScoreSettings {
  if (!isRecord(value) || !hasExactKeys(value, SETTINGS_KEYS)) {
    fail(context, '设置字段不完整或包含未知字段')
  }

  const melodyPartId = boundedString(value.melodyPartId, '主旋律声部', context, 256)
  if (!Array.isArray(value.pianoPartIds) || value.pianoPartIds.length > 64) {
    fail(context, '钢琴声部列表格式不正确')
  }
  const pianoPartIds = value.pianoPartIds.map((partId) =>
    boundedString(partId, '钢琴声部', context, 256),
  )
  if (new Set(pianoPartIds).size !== pianoPartIds.length) {
    fail(context, '钢琴声部不能重复')
  }
  if (!['original', 'generated', 'none'].includes(value.mode as string)) {
    fail(context, '伴奏模式不受支持')
  }
  if (!['block', 'arpeggio', 'waltz'].includes(value.style as string)) {
    fail(context, '钢琴织体不受支持')
  }
  if (value.tonic !== null && (
    typeof value.tonic !== 'number'
    || !Number.isInteger(value.tonic)
    || value.tonic < 0
    || value.tonic > 11
  )) {
    fail(context, '调性主音必须在 0 到 11 之间')
  }
  if (typeof value.minor !== 'boolean') {
    fail(context, '大小调设置格式不正确')
  }

  return {
    melodyPartId,
    pianoPartIds,
    mode: value.mode as ScoreSettings['mode'],
    style: value.style as ScoreSettings['style'],
    tonic: value.tonic as number | null,
    minor: value.minor,
  }
}

export function utf8Size(value: string): number {
  return encoder.encode(value).byteLength
}

export function normalizeFolderName(value: unknown, context = '文件夹'): string {
  if (typeof value !== 'string') fail(context, '名称格式不正确')
  const name = value.trim()
  if (name.length === 0 || name.length > 80) fail(context, '名称须为 1 到 80 个字符')
  return name
}

function validateCoverImage(value: unknown, context: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string') fail(context, '封面格式不正确')
  const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value)
  if (!match || match[1].length === 0 || match[1].length % 4 !== 0) {
    fail(context, '封面只支持 PNG、JPEG 或 WebP 的 Base64 数据')
  }
  if (match[1].length > Math.ceil(MAX_COVER_BYTES / 3) * 4) {
    fail(context, '封面解码后不能超过 512 KiB')
  }
  let decodedBytes: number
  try {
    decodedBytes = atob(match[1]).length
  } catch {
    return fail(context, '封面 Base64 数据无效')
  }
  if (decodedBytes === 0 || decodedBytes > MAX_COVER_BYTES) {
    fail(context, '封面解码后不能超过 512 KiB')
  }
  return value
}

export function validateScoreFolder(value: unknown, context = '文件夹'): ScoreFolder {
  if (!isRecord(value) || !hasExactKeys(value, FOLDER_KEYS)) {
    fail(context, '字段不完整或包含未知字段')
  }
  return {
    id: boundedString(value.id, '编号', context, 256),
    name: normalizeFolderName(value.name, context),
    createdAt: timestamp(value.createdAt, '创建时间', context),
  }
}

export function validateFolderArray(value: unknown, context = '备份中的文件夹'): ScoreFolder[] {
  if (!Array.isArray(value)) fail('备份', 'folders 必须是数组')
  if (value.length > MAX_FOLDERS) fail('备份', `最多包含 ${MAX_FOLDERS} 个文件夹`)
  const folders = value.map((item) => validateScoreFolder(item, context))
  if (new Set(folders.map((folder) => folder.id)).size !== folders.length) {
    fail('备份', '包含重复的文件夹编号')
  }
  if (new Set(folders.map((folder) => folder.name)).size !== folders.length) {
    fail('备份', '包含同名文件夹')
  }
  return folders
}

export function validatePersonalScore(value: unknown, context = '乐谱记录'): PersonalScore {
  if (!isRecord(value) || !hasRecordKeys(value)) {
    fail(context, '字段不完整或包含未知字段')
  }

  const id = boundedString(value.id, '编号', context, 256)
  if (typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint)) {
    fail(context, '内容指纹格式不正确')
  }
  if (typeof value.originalXml !== 'string' || value.originalXml.length === 0) {
    fail(context, '原谱内容不能为空')
  }
  if (utf8Size(value.originalXml) > MAX_SCORE_XML_BYTES) {
    fail(context, '单份原谱不能超过 10 MB')
  }
  const title = boundedString(value.title, '标题', context, 500)
  const composer = boundedString(value.composer, '作者', context, 500, true)
  if (!Array.isArray(value.tags) || value.tags.length > 64) {
    fail(context, '标签列表格式不正确')
  }
  const tags = value.tags.map((tag) => boundedString(tag, '标签', context, 100))
  if (typeof value.favorite !== 'boolean') {
    fail(context, '收藏状态格式不正确')
  }
  const createdAt = timestamp(value.createdAt, '创建时间', context)
  const updatedAt = timestamp(value.updatedAt, '更新时间', context)
  const lastOpenedAt = value.lastOpenedAt === null
    ? null
    : timestamp(value.lastOpenedAt, '最近打开时间', context)

  const record: PersonalScore = {
    id,
    fingerprint: value.fingerprint,
    originalXml: value.originalXml,
    title,
    composer,
    tags,
    favorite: value.favorite,
    createdAt,
    updatedAt,
    lastOpenedAt,
    settings: validateSettings(value.settings, context),
  }
  if (Object.hasOwn(value, 'folderId')) {
    record.folderId = value.folderId === null
      ? null
      : boundedString(value.folderId, '文件夹编号', context, 256)
  }
  if (Object.hasOwn(value, 'coverImage')) record.coverImage = validateCoverImage(value.coverImage, context)
  return record
}

export function validateRecordArray(value: unknown, context = '备份中的乐谱记录'): PersonalScore[] {
  if (!Array.isArray(value)) fail('备份', 'records 必须是数组')
  if (value.length > MAX_BACKUP_RECORDS) fail('备份', `最多包含 ${MAX_BACKUP_RECORDS} 份乐谱`)

  const records: PersonalScore[] = []
  const ids = new Set<string>()
  const fingerprints = new Set<string>()
  let xmlBytes = 0
  for (const item of value) {
    const record = validatePersonalScore(item, context)
    if (ids.has(record.id)) fail('备份', '包含重复的乐谱编号')
    if (fingerprints.has(record.fingerprint)) fail('备份', '包含重复的乐谱内容')
    ids.add(record.id)
    fingerprints.add(record.fingerprint)
    xmlBytes += utf8Size(record.originalXml)
    if (xmlBytes > MAX_BACKUP_BYTES) fail('备份', '总大小不能超过 100 MB')
    records.push(record)
  }
  return records
}

export function validateLibrarySnapshot(value: unknown): LibrarySnapshot {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) {
    fail('曲库备份', '字段不完整或包含未知字段')
  }
  const folders = validateFolderArray(value.folders)
  const records = validateRecordArray(value.records)
  const folderIds = new Set(folders.map((folder) => folder.id))
  if (records.some((record) => record.folderId != null && !folderIds.has(record.folderId))) {
    fail('曲库备份', '乐谱引用了不存在的文件夹')
  }
  return { records, folders }
}
