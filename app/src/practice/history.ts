import type { Take, PitchPoint, TuneStats } from '../types'
import type { PracticeMetadata } from './model'
export type StoredPractice = Omit<Take, 'audioUrl' | 'audioBlob'> & { schemaVersion: 1; audioBlob: Blob; practice: PracticeMetadata }

const DATABASE = 'syrinx-practice'
const STORE = 'practices'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    let blocked = false
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'sessionId' })
    }
    request.onerror = () => reject(request.error ?? new Error('无法打开练习记录。'))
    request.onblocked = () => {
      blocked = true
      reject(new Error('练习记录升级被其他页面占用，请关闭其他 Syrinx 页面后重试。'))
    }
    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => db.close()
      if (blocked) db.close()
      else resolve(db)
    }
  })
}

/** Resolve on commit, never on request success. Each operation closes its own
 * connection, so refreshes/other tabs can upgrade and no Blob cache is retained. */
async function transaction<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore, result: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
  const db = await openDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode)
      let result: T
      let failure: unknown
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(failure ?? tx.error ?? new DOMException('练习记录事务已取消。', 'AbortError'))
      const fail = (error: unknown) => {
        failure = error
        try { tx.abort() } catch { reject(error) }
      }
      try { work(tx.objectStore(STORE), value => { result = value }, fail) } catch (error) { fail(error) }
    })
  } finally { db.close() }
}

const textPresent = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const validTimes = (start: number, stop: number) => Number.isFinite(start) && Number.isFinite(stop) && start >= 0 && stop > start

function validate(take: Take, blob: Blob): asserts take is Take & { practice: PracticeMetadata } {
  const p = take.practice
  if (!textPresent(take.sessionId) || !textPresent(take.songId) || !textPresent(take.mimeType) || !Number.isFinite(take.startedAt) || !Number.isFinite(take.durationSec) || take.durationSec <= 0 || !validTimes(take.startSec, take.stopSec) || !(blob instanceof Blob) || blob.size === 0) throw new Error('录音信息不完整，无法保存。')
  if (!p || !textPresent(p.songVersion) || !textPresent(p.scoringVersion) || !textPresent(p.groupId) || !Number.isInteger(p.round) || !Number.isInteger(p.rounds) || p.round < 1 || p.round > p.rounds || p.rounds > 5 || (p.scoredNotesKey !== undefined && !textPresent(p.scoredNotesKey))) throw new Error('练习版本或轮次信息不完整，无法保存。')
  const r = p.range
  if (r !== null && (!r || !Number.isInteger(r.startMeasure) || !Number.isInteger(r.endMeasure) || r.startMeasure < 1 || r.endMeasure < r.startMeasure || !validTimes(r.startSec, r.stopSec))) throw new Error('练习区间无效，无法保存。')
}

export async function savePractice(take: Take, blob: Blob): Promise<void> {
  validate(take, blob)
  // Explicit serializable fields prevent transient ObjectURLs/extra UI state
  // from leaking into persistent records, even if a caller extends Take.
  const record: StoredPractice = {
    schemaVersion: 1, sessionId: take.sessionId, songId: take.songId, startedAt: take.startedAt,
    durationSec: take.durationSec, mimeType: take.mimeType, startSec: take.startSec, stopSec: take.stopSec,
    pitchTrack: take.pitchTrack, stats: take.stats, audioBlob: blob, practice: { ...take.practice, range: take.practice.range ? { ...take.practice.range } : null },
  }
  await transaction<void>('readwrite', store => { store.put(record) })
}

export async function listPractices(): Promise<StoredPractice[]> {
  const rows = await transaction<StoredPractice[]>('readonly', (store, result) => {
    const request = store.getAll()
    request.onsuccess = () => result(request.result)
  })
  return rows.sort((a, b) => b.startedAt - a.startedAt || a.sessionId.localeCompare(b.sessionId))
}

export async function getPractice(id: string): Promise<StoredPractice | undefined> {
  return transaction('readonly', (store, result) => {
    const request = store.get(id)
    request.onsuccess = () => result(request.result)
  })
}

export async function deletePractice(id: string): Promise<void> {
  await transaction<void>('readwrite', store => { store.delete(id) })
}

export async function clearPractices(): Promise<void> {
  await transaction<void>('readwrite', store => { store.clear() })
}

export async function updatePracticeAnalysis(id: string, pitchTrack: PitchPoint[], stats: TuneStats): Promise<void> {
  await transaction<void>('readwrite', (store, _result, fail) => {
    const request = store.get(id)
    request.onsuccess = () => {
      const existing: StoredPractice | undefined = request.result
      if (!existing) return
      // Read and update in one write transaction: a delete cannot interleave.
      try { store.put({ ...existing, pitchTrack, stats }) } catch (error) { fail(error) }
    }
  })
}
