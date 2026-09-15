import type { LibrarySnapshot, PersonalScore } from './types'
import {
  MAX_BACKUP_BYTES,
  MAX_BACKUP_RECORDS,
  utf8Size,
  validateFolderArray,
  validateLibrarySnapshot,
  validatePersonalScore,
  validateRecordArray,
} from './validate'

const V1_BACKUP_KEYS = ['schemaVersion', 'records'] as const
const V2_BACKUP_KEYS = ['schemaVersion', 'folders', 'records'] as const
const BACKUP_PREFIX = '{"schemaVersion":1,"records":['
const BACKUP_SUFFIX = ']}'
const EMPTY_BACKUP = `${BACKUP_PREFIX}${BACKUP_SUFFIX}`
const EMPTY_BACKUP_BYTES = utf8Size(EMPTY_BACKUP)

export interface BackupPart {
  text: string
  count: number
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

export function encodeBackup(records: PersonalScore[]): string {
  const validated = validateRecordArray(records)
  const text = JSON.stringify({ schemaVersion: 1, records: validated })
  if (utf8Size(text) > MAX_BACKUP_BYTES) {
    throw new Error('备份总大小不能超过 100 MB')
  }
  return text
}

export function encodeBackupParts(
  records: PersonalScore[],
  maxBytes = MAX_BACKUP_BYTES,
): BackupPart[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < EMPTY_BACKUP_BYTES || maxBytes > MAX_BACKUP_BYTES) {
    throw new Error('备份分卷上限必须是有效字节数，且不能超过 100 MB')
  }
  if (!Array.isArray(records)) throw new Error('备份中的乐谱记录无效：必须是数组')
  if (records.length === 0) return [{ text: EMPTY_BACKUP, count: 0 }]

  const ids = new Set<string>()
  const fingerprints = new Set<string>()
  const parts: BackupPart[] = []
  let serializedRecords: string[] = []
  let recordsBytes = 0

  const flush = () => {
    parts.push({
      text: `${BACKUP_PREFIX}${serializedRecords.join(',')}${BACKUP_SUFFIX}`,
      count: serializedRecords.length,
    })
    serializedRecords = []
    recordsBytes = 0
  }

  for (const item of records) {
    const record = validatePersonalScore(item, '备份中的乐谱记录')
    if (ids.has(record.id)) throw new Error('备份包含重复的乐谱编号')
    if (fingerprints.has(record.fingerprint)) throw new Error('备份包含重复的乐谱内容')
    ids.add(record.id)
    fingerprints.add(record.fingerprint)

    const serialized = JSON.stringify(record)
    const serializedBytes = utf8Size(serialized)
    if (EMPTY_BACKUP_BYTES + serializedBytes > maxBytes) {
      throw new Error(`乐谱“${record.title}”单份记录超过备份分卷上限`)
    }

    const separatorBytes = serializedRecords.length === 0 ? 0 : 1
    const wouldExceedBytes = EMPTY_BACKUP_BYTES + recordsBytes + separatorBytes + serializedBytes > maxBytes
    const wouldExceedCount = serializedRecords.length >= MAX_BACKUP_RECORDS
    if (wouldExceedBytes || wouldExceedCount) flush()

    serializedRecords.push(serialized)
    recordsBytes += (serializedRecords.length === 1 ? 0 : 1) + serializedBytes
  }
  flush()
  return parts
}

function validateLibraryRecords(value: unknown, folderIds: Set<string>): PersonalScore[] {
  if (!Array.isArray(value)) throw new Error('曲库备份无效：records 必须是数组')
  const records: PersonalScore[] = []
  const ids = new Set<string>()
  const fingerprints = new Set<string>()
  for (const item of value) {
    const record = validatePersonalScore(item, '曲库备份中的乐谱记录')
    if (ids.has(record.id)) throw new Error('曲库备份包含重复的乐谱编号')
    if (fingerprints.has(record.fingerprint)) throw new Error('曲库备份包含重复的乐谱内容')
    if (record.folderId != null && !folderIds.has(record.folderId)) {
      throw new Error('曲库备份中的乐谱引用了不存在的文件夹')
    }
    ids.add(record.id)
    fingerprints.add(record.fingerprint)
    records.push(record)
  }
  return records
}

export function encodeLibraryBackupParts(
  snapshot: LibrarySnapshot,
  maxBytes = MAX_BACKUP_BYTES,
): BackupPart[] {
  if (!isObject(snapshot) || !hasExactKeys(snapshot, ['records', 'folders'])) {
    throw new Error('曲库备份无效：字段不完整或包含未知字段')
  }
  const folders = validateFolderArray(snapshot.folders)
  const folderIds = new Set(folders.map((folder) => folder.id))
  const records = validateLibraryRecords(snapshot.records, folderIds)
  const prefix = `{"schemaVersion":2,"folders":${JSON.stringify(folders)},"records":[`
  const suffix = ']}'
  const emptyText = `${prefix}${suffix}`
  const baseBytes = utf8Size(emptyText)
  if (!Number.isSafeInteger(maxBytes) || maxBytes < baseBytes || maxBytes > MAX_BACKUP_BYTES) {
    throw new Error('曲库备份分卷上限无效，或完整文件夹元数据无法放入单卷')
  }
  if (records.length === 0) return [{ text: emptyText, count: 0 }]

  const parts: BackupPart[] = []
  let serializedRecords: string[] = []
  let recordsBytes = 0
  const flush = () => {
    parts.push({ text: `${prefix}${serializedRecords.join(',')}${suffix}`, count: serializedRecords.length })
    serializedRecords = []
    recordsBytes = 0
  }

  for (const record of records) {
    const serialized = JSON.stringify(record)
    const serializedBytes = utf8Size(serialized)
    if (baseBytes + serializedBytes > maxBytes) {
      throw new Error(`乐谱“${record.title}”单份记录超过曲库备份分卷上限`)
    }
    const separatorBytes = serializedRecords.length === 0 ? 0 : 1
    if (
      serializedRecords.length >= MAX_BACKUP_RECORDS
      || baseBytes + recordsBytes + separatorBytes + serializedBytes > maxBytes
    ) {
      flush()
    }
    serializedRecords.push(serialized)
    recordsBytes += (serializedRecords.length === 1 ? 0 : 1) + serializedBytes
  }
  flush()
  return parts
}

function parseBackup(text: string): Record<string, unknown> {
  if (typeof text !== 'string' || utf8Size(text) > MAX_BACKUP_BYTES) {
    throw new Error('备份总大小不能超过 100 MB')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('备份文件不是有效的 JSON')
  }
  if (!isObject(parsed)) throw new Error('备份格式不正确')
  return parsed
}

export function decodeBackup(text: string): PersonalScore[] {
  const parsed = parseBackup(text)
  if (!hasExactKeys(parsed, V1_BACKUP_KEYS)) {
    throw new Error('备份格式不正确或包含未知字段')
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error('备份版本不受支持')
  }
  return validateRecordArray(parsed.records)
}

export function decodeLibraryBackup(text: string): LibrarySnapshot {
  const parsed = parseBackup(text)
  if (parsed.schemaVersion === 1) {
    if (!hasExactKeys(parsed, V1_BACKUP_KEYS)) throw new Error('备份格式不正确或包含未知字段')
    return { records: validateRecordArray(parsed.records), folders: [] }
  }
  if (parsed.schemaVersion === 2) {
    if (!hasExactKeys(parsed, V2_BACKUP_KEYS)) throw new Error('曲库备份格式不正确或包含未知字段')
    return validateLibrarySnapshot({ records: parsed.records, folders: parsed.folders })
  }
  throw new Error('备份版本不受支持')
}
