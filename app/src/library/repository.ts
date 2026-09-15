import type {
  LibrarySnapshot,
  PersonalScore,
  PersonalScoreSummary,
  ScoreFolder,
} from './types'
import {
  MAX_FOLDERS,
  normalizeFolderName,
  validateLibrarySnapshot,
  validatePersonalScore,
  validateRecordArray,
  validateScoreFolder,
} from './validate'

const DEFAULT_DATABASE_NAME = 'syrinx-personal-score-library'
const DATABASE_VERSION = 2
const SCORE_STORE = 'scores'
const FOLDER_STORE = 'folders'
const FINGERPRINT_INDEX = 'fingerprint'
const FOLDER_ID_INDEX = 'folderId'
const FOLDER_NAME_INDEX = 'name'
const EDITABLE_KEYS = new Set([
  'title',
  'composer',
  'tags',
  'favorite',
  'settings',
  'lastOpenedAt',
  'folderId',
  'coverImage',
])

export type ScoreUpdate = Partial<Pick<
  PersonalScore,
  | 'title'
  | 'composer'
  | 'tags'
  | 'favorite'
  | 'settings'
  | 'lastOpenedAt'
  | 'folderId'
  | 'coverImage'
>>

export interface ScoreRepository {
  list(): Promise<PersonalScore[]>
  listSummaries(): Promise<PersonalScoreSummary[]>
  get(id: string): Promise<PersonalScore | undefined>
  getCover(id: string): Promise<string | null>
  add(record: PersonalScore): Promise<{ record: PersonalScore; duplicate: boolean }>
  update(id: string, patch: ScoreUpdate): Promise<PersonalScore>
  remove(id: string): Promise<void>
  restore(records: PersonalScore[]): Promise<{ added: number; skipped: number }>
  listFolders(): Promise<ScoreFolder[]>
  createFolder(name: string): Promise<ScoreFolder>
  renameFolder(id: string, name: string): Promise<ScoreFolder>
  removeFolder(id: string): Promise<void>
  moveScores(ids: string[], folderId: string | null): Promise<void>
  snapshot(): Promise<LibrarySnapshot>
  restoreLibrary(snapshot: LibrarySnapshot): Promise<{ added: number; skipped: number; foldersAdded: number }>
}

class RepositoryError extends Error {}

function errorName(error: unknown): string | undefined {
  if (error instanceof DOMException) return error.name
  if (typeof error === 'object' && error !== null && 'name' in error) {
    return String((error as { name: unknown }).name)
  }
  return undefined
}

function storageError(error: unknown, operation: 'open' | 'read' | 'write'): Error {
  if (error instanceof RepositoryError) return error
  if (errorName(error) === 'QuotaExceededError') {
    return new RepositoryError('本地存储空间不足，请先导出备份并删除部分乐谱。')
  }
  if (operation === 'open') {
    return new RepositoryError('无法打开本地曲库，请检查浏览器存储权限。')
  }
  if (operation === 'read') {
    return new RepositoryError('无法读取本地曲库，请稍后重试。')
  }
  return new RepositoryError('无法保存本地曲库，请稍后重试。')
}

function upgradeDatabase(request: IDBOpenDBRequest): void {
  const database = request.result
  const transaction = request.transaction
  if (!transaction) throw new DOMException('Missing upgrade transaction', 'InvalidStateError')

  const scores = database.objectStoreNames.contains(SCORE_STORE)
    ? transaction.objectStore(SCORE_STORE)
    : database.createObjectStore(SCORE_STORE, { keyPath: 'id' })
  if (!scores.indexNames.contains(FINGERPRINT_INDEX)) {
    scores.createIndex(FINGERPRINT_INDEX, FINGERPRINT_INDEX, { unique: true })
  }
  if (!scores.indexNames.contains(FOLDER_ID_INDEX)) {
    scores.createIndex(FOLDER_ID_INDEX, FOLDER_ID_INDEX, { unique: false })
  }

  if (!database.objectStoreNames.contains(FOLDER_STORE)) {
    const folders = database.createObjectStore(FOLDER_STORE, { keyPath: 'id' })
    folders.createIndex(FOLDER_NAME_INDEX, FOLDER_NAME_INDEX, { unique: true })
  }
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest
    try {
      request = indexedDB.open(name, DATABASE_VERSION)
    } catch (error) {
      reject(storageError(error, 'open'))
      return
    }

    let settled = false
    request.onupgradeneeded = () => {
      try {
        upgradeDatabase(request)
      } catch (error) {
        request.transaction?.abort()
        if (!settled) {
          settled = true
          reject(storageError(error, 'open'))
        }
      }
    }
    request.onsuccess = () => {
      if (settled) {
        request.result.close()
        return
      }
      settled = true
      resolve(request.result)
    }
    request.onerror = () => {
      if (!settled) {
        settled = true
        reject(storageError(request.error, 'open'))
      }
    }
    request.onblocked = () => {
      if (!settled) {
        settled = true
        reject(new RepositoryError('无法打开本地曲库：数据库正在被其他窗口升级。'))
      }
    }
  })
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new DOMException('IndexedDB request failed', 'UnknownError'))
  })
}

function cursorMap<T>(
  request: IDBRequest<IDBCursorWithValue | null>,
  map: (value: unknown) => T,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const values: T[] = []
    request.onerror = () => reject(request.error ?? new DOMException('IndexedDB cursor failed', 'UnknownError'))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve(values)
        return
      }
      values.push(map(cursor.value))
      cursor.continue()
    }
  })
}

function updateFolderScores(store: IDBObjectStore, folderId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = store.index(FOLDER_ID_INDEX).openCursor(IDBKeyRange.only(folderId))
    request.onerror = () => reject(request.error ?? new DOMException('IndexedDB cursor failed', 'UnknownError'))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve()
        return
      }
      const current = cursor.value as PersonalScore
      const update = cursor.update({
        ...current,
        folderId: null,
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      })
      update.onerror = () => reject(update.error ?? new DOMException('IndexedDB update failed', 'UnknownError'))
      update.onsuccess = () => cursor.continue()
    }
  })
}

function transactionSettled(transaction: IDBTransaction): Promise<DOMException | null> {
  return new Promise((resolve) => {
    transaction.oncomplete = () => resolve(null)
    transaction.onabort = () => resolve(
      transaction.error ?? new DOMException('IndexedDB transaction aborted', 'AbortError'),
    )
  })
}

async function runTransaction<T>(
  database: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  work: (transaction: IDBTransaction) => Promise<T>,
): Promise<T> {
  const transaction = database.transaction(stores, mode)
  const settled = transactionSettled(transaction)
  try {
    const result = await work(transaction)
    const transactionError = await settled
    if (transactionError) throw transactionError
    return result
  } catch (error) {
    try {
      transaction.abort()
    } catch {
      // The browser already completed or aborted the transaction.
    }
    await settled
    throw error
  }
}

async function runWithDatabase<T>(name: string, work: (database: IDBDatabase) => Promise<T>): Promise<T> {
  const database = await openDatabase(name)
  try {
    return await work(database)
  } finally {
    database.close()
  }
}

function assertId(id: string, label = '乐谱编号'): void {
  if (typeof id !== 'string' || id.trim().length === 0 || id.length > 256) {
    throw new RepositoryError(`${label}无效。`)
  }
}

function validatePatch(patch: ScoreUpdate): void {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new RepositoryError('乐谱更新字段无效。')
  }
  for (const key of Object.keys(patch)) {
    if (!EDITABLE_KEYS.has(key)) {
      throw new RepositoryError(`乐谱更新字段不受支持：${key}`)
    }
  }
}

function newId(usedIds?: Set<string>): string {
  let id: string
  do {
    id = crypto.randomUUID()
  } while (usedIds?.has(id))
  return id
}

async function fingerprint(xml: string): Promise<string> {
  const bytes = new TextEncoder().encode(xml)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function verifyFingerprints(records: PersonalScore[]): Promise<void> {
  for (const record of records) {
    if (await fingerprint(record.originalXml) !== record.fingerprint) {
      throw new RepositoryError(`备份中的乐谱“${record.title}”内容与指纹不一致。`)
    }
  }
}

async function requireFolder(store: IDBObjectStore, folderId: string | null | undefined): Promise<void> {
  if (folderId == null) return
  if (!await requestResult(store.get(folderId))) throw new RepositoryError('指定的文件夹不存在。')
}

function summaryOf(record: PersonalScore): PersonalScoreSummary {
  const summary: PersonalScoreSummary = {
    id: record.id,
    fingerprint: record.fingerprint,
    title: record.title,
    composer: record.composer,
    tags: record.tags,
    favorite: record.favorite,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastOpenedAt: record.lastOpenedAt,
    settings: record.settings,
    hasCover: typeof record.coverImage === 'string',
  }
  if (Object.hasOwn(record, 'folderId')) summary.folderId = record.folderId
  return summary
}

async function addRestoredRecords(
  scoreStore: IDBObjectStore,
  records: PersonalScore[],
  folderMap: Map<string, string>,
  validFolderIds: Set<string>,
): Promise<{ added: number; skipped: number }> {
  const existing = await requestResult(scoreStore.getAll()) as PersonalScore[]
  const usedIds = new Set(existing.map((record) => record.id))
  const usedFingerprints = new Set(existing.map((record) => record.fingerprint))
  const additions: PersonalScore[] = []
  let skipped = 0

  for (const record of records) {
    if (usedFingerprints.has(record.fingerprint)) {
      skipped += 1
      continue
    }
    const sourceFolderId = record.folderId
    const mappedFolderId = sourceFolderId == null ? sourceFolderId : folderMap.get(sourceFolderId)
    if (sourceFolderId != null && (!mappedFolderId || !validFolderIds.has(mappedFolderId))) {
      throw new RepositoryError('备份中的乐谱引用了不存在的文件夹。')
    }
    const restored = validatePersonalScore({
      ...record,
      id: usedIds.has(record.id) ? newId(usedIds) : record.id,
      ...(Object.hasOwn(record, 'folderId') ? { folderId: mappedFolderId } : {}),
    })
    usedIds.add(restored.id)
    usedFingerprints.add(restored.fingerprint)
    additions.push(restored)
  }

  for (const record of additions) await requestResult(scoreStore.add(record))
  return { added: additions.length, skipped }
}

export function createScoreRepository(name = DEFAULT_DATABASE_NAME): ScoreRepository {
  return {
    async list() {
      return runWithDatabase(name, async (database) => {
        try {
          return await runTransaction(database, SCORE_STORE, 'readonly', async (transaction) =>
            requestResult(transaction.objectStore(SCORE_STORE).getAll()) as Promise<PersonalScore[]>,
          )
        } catch (error) {
          throw storageError(error, 'read')
        }
      })
    },

    async listSummaries() {
      return runWithDatabase(name, async (database) => {
        try {
          return await runTransaction(database, SCORE_STORE, 'readonly', async (transaction) =>
            cursorMap(
              transaction.objectStore(SCORE_STORE).openCursor(),
              (value) => summaryOf(value as PersonalScore),
            ),
          )
        } catch (error) {
          throw storageError(error, 'read')
        }
      })
    },

    async get(id) {
      assertId(id)
      return runWithDatabase(name, async (database) => {
        try {
          return await runTransaction(database, SCORE_STORE, 'readonly', async (transaction) =>
            requestResult(transaction.objectStore(SCORE_STORE).get(id)) as Promise<PersonalScore | undefined>,
          )
        } catch (error) {
          throw storageError(error, 'read')
        }
      })
    },

    async getCover(id) {
      assertId(id)
      return runWithDatabase(name, async (database) => {
        try {
          const record = await runTransaction(database, SCORE_STORE, 'readonly', async (transaction) =>
            requestResult(transaction.objectStore(SCORE_STORE).get(id)) as Promise<PersonalScore | undefined>,
          )
          return record?.coverImage ?? null
        } catch (error) {
          throw storageError(error, 'read')
        }
      })
    },

    async add(record) {
      const validated = validatePersonalScore(record)
      return runWithDatabase(name, async (database) => {
        try {
          await runTransaction(database, [SCORE_STORE, FOLDER_STORE], 'readwrite', async (transaction) => {
            await requireFolder(transaction.objectStore(FOLDER_STORE), validated.folderId)
            await requestResult(transaction.objectStore(SCORE_STORE).add(validated))
          })
          return { record: validated, duplicate: false }
        } catch (error) {
          if (errorName(error) === 'ConstraintError') {
            try {
              const existing = await runTransaction(database, SCORE_STORE, 'readonly', async (transaction) =>
                requestResult(transaction.objectStore(SCORE_STORE).index(FINGERPRINT_INDEX).get(validated.fingerprint)) as Promise<PersonalScore | undefined>,
              )
              if (existing) return { record: existing, duplicate: true }
              throw new RepositoryError('乐谱编号已存在，请重新导入。')
            } catch (lookupError) {
              throw storageError(lookupError, 'read')
            }
          }
          throw storageError(error, 'write')
        }
      })
    },

    async update(id, patch) {
      assertId(id)
      validatePatch(patch)
      return runWithDatabase(name, async (database) => {
        try {
          return await runTransaction(database, [SCORE_STORE, FOLDER_STORE], 'readwrite', async (transaction) => {
            const scoreStore = transaction.objectStore(SCORE_STORE)
            const current = await requestResult(scoreStore.get(id)) as PersonalScore | undefined
            if (!current) throw new RepositoryError('找不到要更新的乐谱。')
            if (Object.hasOwn(patch, 'folderId')) {
              await requireFolder(transaction.objectStore(FOLDER_STORE), patch.folderId)
            }
            const candidate = validatePersonalScore({
              ...current,
              ...patch,
              id: current.id,
              fingerprint: current.fingerprint,
              originalXml: current.originalXml,
              createdAt: current.createdAt,
              updatedAt: Math.max(Date.now(), current.updatedAt + 1),
            })
            await requestResult(scoreStore.put(candidate))
            return candidate
          })
        } catch (error) {
          throw storageError(error, 'write')
        }
      })
    },

    async remove(id) {
      assertId(id)
      return runWithDatabase(name, async (database) => {
        try {
          await runTransaction(database, SCORE_STORE, 'readwrite', async (transaction) => {
            await requestResult(transaction.objectStore(SCORE_STORE).delete(id))
          })
        } catch (error) {
          throw storageError(error, 'write')
        }
      })
    },

    async restore(records) {
      const validated = validateRecordArray(records)
      await verifyFingerprints(validated)
      return runWithDatabase(name, async (database) => {
        try {
          return await runTransaction(database, [SCORE_STORE, FOLDER_STORE], 'readwrite', async (transaction) => {
            const folders = await requestResult(transaction.objectStore(FOLDER_STORE).getAll()) as ScoreFolder[]
            const folderIds = new Set(folders.map((folder) => folder.id))
            const folderMap = new Map(folders.map((folder) => [folder.id, folder.id]))
            return addRestoredRecords(transaction.objectStore(SCORE_STORE), validated, folderMap, folderIds)
          })
        } catch (error) {
          throw storageError(error, 'write')
        }
      })
    },

    async listFolders() {
      return runWithDatabase(name, async (database) => {
        try {
          const folders = await runTransaction(database, FOLDER_STORE, 'readonly', async (transaction) =>
            requestResult(transaction.objectStore(FOLDER_STORE).getAll()) as Promise<ScoreFolder[]>,
          )
          return folders.sort((left, right) => left.createdAt - right.createdAt || left.name.localeCompare(right.name))
        } catch (error) {
          throw storageError(error, 'read')
        }
      })
    },

    async createFolder(rawName) {
      const folderName = normalizeFolderName(rawName)
      return runWithDatabase(name, async (database) => {
        try {
          return await runTransaction(database, FOLDER_STORE, 'readwrite', async (transaction) => {
            const store = transaction.objectStore(FOLDER_STORE)
            if (await requestResult(store.index(FOLDER_NAME_INDEX).get(folderName))) {
              throw new RepositoryError('已存在同名文件夹。')
            }
            if (await requestResult(store.count()) >= MAX_FOLDERS) {
              throw new RepositoryError(`文件夹数量不能超过 ${MAX_FOLDERS} 个。`)
            }
            const folder = validateScoreFolder({ id: newId(), name: folderName, createdAt: Date.now() })
            await requestResult(store.add(folder))
            return folder
          })
        } catch (error) {
          if (errorName(error) === 'ConstraintError') throw new RepositoryError('已存在同名文件夹。')
          throw storageError(error, 'write')
        }
      })
    },

    async renameFolder(id, rawName) {
      assertId(id, '文件夹编号')
      const folderName = normalizeFolderName(rawName)
      return runWithDatabase(name, async (database) => {
        try {
          return await runTransaction(database, FOLDER_STORE, 'readwrite', async (transaction) => {
            const store = transaction.objectStore(FOLDER_STORE)
            const current = await requestResult(store.get(id)) as ScoreFolder | undefined
            if (!current) throw new RepositoryError('找不到要重命名的文件夹。')
            const duplicate = await requestResult(store.index(FOLDER_NAME_INDEX).get(folderName)) as ScoreFolder | undefined
            if (duplicate && duplicate.id !== id) throw new RepositoryError('已存在同名文件夹。')
            const renamed = validateScoreFolder({ ...current, name: folderName })
            await requestResult(store.put(renamed))
            return renamed
          })
        } catch (error) {
          if (errorName(error) === 'ConstraintError') throw new RepositoryError('已存在同名文件夹。')
          throw storageError(error, 'write')
        }
      })
    },

    async removeFolder(id) {
      assertId(id, '文件夹编号')
      return runWithDatabase(name, async (database) => {
        try {
          await runTransaction(database, [SCORE_STORE, FOLDER_STORE], 'readwrite', async (transaction) => {
            const folderStore = transaction.objectStore(FOLDER_STORE)
            if (!await requestResult(folderStore.get(id))) throw new RepositoryError('找不到要删除的文件夹。')
            await updateFolderScores(transaction.objectStore(SCORE_STORE), id)
            await requestResult(folderStore.delete(id))
          })
        } catch (error) {
          throw storageError(error, 'write')
        }
      })
    },

    async moveScores(ids, folderId) {
      if (!Array.isArray(ids) || ids.length > 5_000) throw new RepositoryError('批量移动的乐谱列表无效。')
      for (const id of ids) assertId(id)
      if (new Set(ids).size !== ids.length) throw new RepositoryError('批量移动的乐谱编号不能重复。')
      if (folderId !== null) assertId(folderId, '文件夹编号')

      return runWithDatabase(name, async (database) => {
        try {
          await runTransaction(database, [SCORE_STORE, FOLDER_STORE], 'readwrite', async (transaction) => {
            await requireFolder(transaction.objectStore(FOLDER_STORE), folderId)
            const store = transaction.objectStore(SCORE_STORE)
            const records: PersonalScore[] = []
            for (const id of ids) {
              const record = await requestResult(store.get(id)) as PersonalScore | undefined
              if (!record) throw new RepositoryError(`找不到要移动的乐谱：${id}`)
              records.push(record)
            }
            const now = Date.now()
            for (const record of records) {
              await requestResult(store.put(validatePersonalScore({
                ...record,
                folderId,
                updatedAt: Math.max(now, record.updatedAt + 1),
              })))
            }
          })
        } catch (error) {
          throw storageError(error, 'write')
        }
      })
    },

    async snapshot() {
      return runWithDatabase(name, async (database) => {
        try {
          return await runTransaction(database, [SCORE_STORE, FOLDER_STORE], 'readonly', async (transaction) => {
            const scoresRequest = transaction.objectStore(SCORE_STORE).getAll()
            const foldersRequest = transaction.objectStore(FOLDER_STORE).getAll()
            const [records, folders] = await Promise.all([
              requestResult(scoresRequest) as Promise<PersonalScore[]>,
              requestResult(foldersRequest) as Promise<ScoreFolder[]>,
            ])
            return { records, folders }
          })
        } catch (error) {
          throw storageError(error, 'read')
        }
      })
    },

    async restoreLibrary(snapshot) {
      const validated = validateLibrarySnapshot(snapshot)
      await verifyFingerprints(validated.records)
      return runWithDatabase(name, async (database) => {
        try {
          return await runTransaction(database, [SCORE_STORE, FOLDER_STORE], 'readwrite', async (transaction) => {
            const folderStore = transaction.objectStore(FOLDER_STORE)
            const existingFolders = await requestResult(folderStore.getAll()) as ScoreFolder[]
            const byName = new Map(existingFolders.map((folder) => [folder.name, folder]))
            const usedFolderIds = new Set(existingFolders.map((folder) => folder.id))
            const folderMap = new Map<string, string>()
            const folderAdditions: ScoreFolder[] = []

            for (const folder of validated.folders) {
              const sameName = byName.get(folder.name)
              if (sameName) {
                folderMap.set(folder.id, sameName.id)
                continue
              }
              const restored = usedFolderIds.has(folder.id)
                ? { ...folder, id: newId(usedFolderIds) }
                : folder
              folderMap.set(folder.id, restored.id)
              usedFolderIds.add(restored.id)
              byName.set(restored.name, restored)
              folderAdditions.push(restored)
            }
            if (existingFolders.length + folderAdditions.length > MAX_FOLDERS) {
              throw new RepositoryError(`文件夹数量不能超过 ${MAX_FOLDERS} 个。`)
            }

            for (const folder of folderAdditions) await requestResult(folderStore.add(folder))
            const recordsResult = await addRestoredRecords(
              transaction.objectStore(SCORE_STORE),
              validated.records,
              folderMap,
              usedFolderIds,
            )
            return { ...recordsResult, foldersAdded: folderAdditions.length }
          })
        } catch (error) {
          throw storageError(error, 'write')
        }
      })
    },
  }
}

export const scoreRepository = createScoreRepository()
