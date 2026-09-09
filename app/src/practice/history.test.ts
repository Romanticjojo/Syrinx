import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Take, TuneStats } from '../types'
import { clearPractices, deletePractice, getPractice, listPractices, savePractice, updatePracticeAnalysis, type StoredPractice } from './history'

// Narrow event adapter: request success precedes transaction completion; writes
// become visible only on commit. Browser acceptance must additionally verify IDB.
function eventDatabase() {
  let rows = new Map<string, StoredPractice>()
  let created = false
  const control = { abortNextWrite: false, quotaNextWrite: false, connections: 0 }
  const copy = (row: StoredPractice): StoredPractice => ({
    ...structuredClone({ ...row, audioBlob: undefined }), audioBlob: row.audioBlob.slice(0, row.audioBlob.size, row.audioBlob.type),
  })
  const factory = { open: () => {
    const request = {} as IDBOpenDBRequest
    let closed = false
    control.connections++
    const db = {
      objectStoreNames: { contains: () => created },
      createObjectStore: () => { created = true },
      close: () => { if (!closed) { closed = true; control.connections-- } },
      transaction: (_name: string, mode: IDBTransactionMode) => {
        const draft = new Map([...rows].map(([id, row]) => [id, copy(row)]))
        let pending = 0
        let finished = false
        const tx = { error: null, oncomplete: null, onabort: null, onerror: null } as unknown as IDBTransaction
        const abort = (error: DOMException) => {
          if (finished) return
          finished = true
          Object.assign(tx, { error })
          tx.onabort?.call(tx, new Event('abort'))
        }
        const schedule = <T>(operation: () => T) => {
          const req = {} as IDBRequest<T>
          pending++
          queueMicrotask(() => {
            if (finished) return
            if (mode === 'readwrite' && control.quotaNextWrite) {
              control.quotaNextWrite = false
              const error = new DOMException('Storage full', 'QuotaExceededError')
              Object.assign(req, { error })
              req.onerror?.call(req, new Event('error'))
              abort(error)
              return
            }
            Object.assign(req, { result: operation() })
            req.onsuccess?.call(req, new Event('success'))
            pending--
            setTimeout(() => {
              if (pending || finished) return
              if (mode === 'readwrite' && control.abortNextWrite) {
                control.abortNextWrite = false
                abort(new DOMException('Commit aborted', 'AbortError'))
                return
              }
              finished = true
              if (mode === 'readwrite') rows = draft
              tx.oncomplete?.call(tx, new Event('complete'))
            }, 0)
          })
          return req
        }
        Object.assign(tx, {
          abort: () => abort(new DOMException('Aborted', 'AbortError')),
          objectStore: () => ({
            put: (row: StoredPractice) => schedule(() => { draft.set(row.sessionId, copy(row)); return row.sessionId }),
            get: (id: string) => schedule(() => draft.has(id) ? copy(draft.get(id)!) : undefined),
            getAll: () => schedule(() => [...draft.values()].map(copy)),
            delete: (id: string) => schedule(() => { draft.delete(id) }),
            clear: () => schedule(() => { draft.clear() }),
          }),
        })
        return tx
      },
    }
    queueMicrotask(() => {
      Object.assign(request, { result: db })
      if (!created) request.onupgradeneeded?.call(request, new Event('upgradeneeded') as IDBVersionChangeEvent)
      request.onsuccess?.call(request, new Event('success'))
    })
    return request
  } }
  return { factory, control }
}

const stats: TuneStats = { inTuneRatio: 1, avgAbsCents: 12, noteCount: 1, totalNoteCount: 2, missedNoteCount: 1, coverageRatio: 0.5 }
function take(id = 'first', startedAt = 100): Take {
  return {
    sessionId: id, songId: 'song', startedAt, durationSec: 2, audioUrl: 'blob:temporary', mimeType: 'audio/webm',
    startSec: 0, stopSec: 2, pitchTrack: null, stats: null,
    practice: { songVersion: 'content-v1', scoringVersion: 'pitch-v2-captured-notes', range: { startMeasure: 1, endMeasure: 1, startSec: 0, stopSec: 2 }, groupId: 'group', round: 1, rounds: 3 },
  }
}

describe('practice history transaction boundary', () => {
  let adapter: ReturnType<typeof eventDatabase>
  beforeEach(() => { adapter = eventDatabase(); vi.stubGlobal('indexedDB', adapter.factory) })
  afterEach(() => vi.unstubAllGlobals())
  it('roundtrips original Blob bytes and metadata over closed/reopened connections without ObjectURLs', async () => {
    await savePractice(take(), new Blob(['original recording'], { type: 'audio/webm' }))
    expect(adapter.control.connections).toBe(0)
    const stored = await getPractice('first')
    expect(stored?.schemaVersion).toBe(1)
    expect(await stored?.audioBlob.text()).toBe('original recording')
    expect(stored?.audioBlob.type).toBe('audio/webm')
    expect(stored).not.toHaveProperty('audioUrl')
    expect(stored?.practice).toEqual(take().practice)
    expect(adapter.control.connections).toBe(0)
  })
  it('upserts idempotently, sorts newest first, deletes individually and clears all', async () => {
    await savePractice(take(), new Blob(['old']))
    await savePractice(take('second', 200), new Blob(['second']))
    await savePractice(take(), new Blob(['replacement']))
    expect((await listPractices()).map(row => row.sessionId)).toEqual(['second', 'first'])
    expect(await (await getPractice('first'))?.audioBlob.text()).toBe('replacement')
    await deletePractice('first')
    expect(await getPractice('first')).toBeUndefined()
    await clearPractices()
    expect(await listPractices()).toEqual([])
  })
  it('updates analysis in place while retaining audio and does not resurrect deleted recordings', async () => {
    await savePractice(take(), new Blob(['audio']))
    const track = [{ time: 0.5, hz: 440, cents: 0 }]
    await updatePracticeAnalysis('first', track, stats)
    expect(await getPractice('first')).toMatchObject({ pitchTrack: track, stats })
    expect(await (await getPractice('first'))?.audioBlob.text()).toBe('audio')
    await deletePractice('first')
    await updatePracticeAnalysis('first', track, stats)
    expect(await getPractice('first')).toBeUndefined()
  })
  it('rejects transaction abort after a successful put and keeps old record intact', async () => {
    await savePractice(take(), new Blob(['original']))
    adapter.control.abortNextWrite = true
    await expect(savePractice(take(), new Blob(['discarded']))).rejects.toMatchObject({ name: 'AbortError' })
    expect(await (await getPractice('first'))?.audioBlob.text()).toBe('original')
    expect(adapter.control.connections).toBe(0)
  })
  it('propagates quota failure without deleting older recordings', async () => {
    await savePractice(take(), new Blob(['keep']))
    adapter.control.quotaNextWrite = true
    await expect(savePractice(take('second'), new Blob(['fail']))).rejects.toMatchObject({ name: 'QuotaExceededError' })
    expect((await listPractices()).map(row => row.sessionId)).toEqual(['first'])
  })
  it.each([
    { practice: undefined }, { sessionId: '' }, { songId: '' }, { startSec: NaN }, { stopSec: 0 },
    { practice: { ...take().practice!, songVersion: '' } },
    { practice: { ...take().practice!, scoringVersion: '' } },
    { practice: { ...take().practice!, groupId: '' } },
    { practice: { ...take().practice!, round: 0 } },
    { practice: { ...take().practice!, rounds: 6 } },
    { practice: { ...take().practice!, range: { startMeasure: 0, endMeasure: 1, startSec: 0, stopSec: 2 } } },
  ])('rejects incomplete/invalid metadata before opening the database %#', async patch => {
    await expect(savePractice({ ...take(), ...patch }, new Blob(['audio']))).rejects.toThrow()
    expect(adapter.control.connections).toBe(0)
    expect(await listPractices()).toEqual([])
  })
})
