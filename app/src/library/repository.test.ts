import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createScoreRepository, type ScoreRepository } from './repository'
import type { LibrarySnapshot, PersonalScore, ScoreFolder } from './types'

const SHA256 = {
  A: '559aead08264d5795d3909718cdd05abd49572e84fe55590eef31a88a08fdffd',
  B: 'df7e70e5021544f4834bbee64a9e3789febc4be81470df629cad6ddb03320a5c',
  C: '6b23c0d5f35d1b11f9b683f0b0a617355deb11277d91ae091d399c655b87940d',
} as const

function score(content: keyof typeof SHA256, overrides: Partial<PersonalScore> = {}): PersonalScore {
  return {
    id: `score-${content.toLowerCase()}`,
    fingerprint: SHA256[content],
    originalXml: content,
    title: `曲目 ${content}`,
    composer: '作者',
    tags: ['练习'],
    favorite: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
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

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error(`数据库 ${name} 仍被占用`))
  })
}

function folder(id: string, name: string, createdAt = 1_700_000_000_000): ScoreFolder {
  return { id, name, createdAt }
}

function seedVersionOne(name: string, record: PersonalScore): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('scores', { keyPath: 'id' })
      store.createIndex('fingerprint', 'fingerprint', { unique: true })
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const database = request.result
      const transaction = database.transaction('scores', 'readwrite')
      transaction.objectStore('scores').add(record)
      transaction.oncomplete = () => {
        database.close()
        resolve()
      }
      transaction.onabort = () => {
        database.close()
        reject(transaction.error)
      }
    }
  })
}

let databaseName: string
let repository: ScoreRepository

beforeEach(() => {
  databaseName = `syrinx-library-test-${crypto.randomUUID()}`
  repository = createScoreRepository(databaseName)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await deleteDatabase(databaseName)
})

describe('IndexedDB 个人曲库', () => {
  it('写入完成后可由重新创建的仓储读取完整记录', async () => {
    const record = score('A')
    await repository.add(record)

    const reopened = createScoreRepository(databaseName)

    expect(await reopened.get(record.id)).toEqual(record)
    expect(await reopened.list()).toEqual([record])
  })

  it('相同内容重复导入时返回原记录且保留既有编辑', async () => {
    const edited = score('A', { title: '我改过的标题', tags: ['珍藏'], favorite: true })
    await repository.add(edited)

    const result = await repository.add(score('A', { id: 'another-id', title: '导入标题' }))

    expect(result).toEqual({ record: edited, duplicate: true })
    expect(await repository.list()).toEqual([edited])
  })

  it('并发写入相同指纹时也只保留一份', async () => {
    const results = await Promise.all([
      repository.add(score('A', { id: 'first' })),
      createScoreRepository(databaseName).add(score('A', { id: 'second' })),
    ])

    expect(results.filter((result) => result.duplicate)).toHaveLength(1)
    expect(results.filter((result) => !result.duplicate)).toHaveLength(1)
    expect(await repository.list()).toHaveLength(1)
  })

  it('只更新可编辑字段并保持原始 XML 与指纹不变', async () => {
    const original = score('A')
    await repository.add(original)

    const updated = await repository.update(original.id, {
      title: '新标题',
      composer: '新作者',
      tags: ['新标签'],
      favorite: true,
      lastOpenedAt: 1_800_000_000_000,
      settings: { ...original.settings, mode: 'none', pianoPartIds: [] },
    })

    expect(updated).toMatchObject({
      title: '新标题',
      composer: '新作者',
      tags: ['新标签'],
      favorite: true,
      lastOpenedAt: 1_800_000_000_000,
      originalXml: 'A',
      fingerprint: SHA256.A,
      createdAt: original.createdAt,
    })
    expect(updated.updatedAt).toBeGreaterThan(original.updatedAt)
  })

  it('拒绝越权更新和不存在的记录', async () => {
    await repository.add(score('A'))

    await expect(repository.update('score-a', { originalXml: 'B' } as never)).rejects.toThrow(/更新字段/)
    await expect(repository.update('missing', { title: '不存在' })).rejects.toThrow(/找不到/)
    expect((await repository.get('score-a'))?.originalXml).toBe('A')
  })

  it('删除指定记录而不影响其他记录', async () => {
    await repository.add(score('A'))
    await repository.add(score('B'))

    await repository.remove('score-a')

    expect(await repository.get('score-a')).toBeUndefined()
    expect(await repository.get('score-b')).toEqual(score('B'))
  })

  it('恢复时跳过内容重复项，并为不同内容的编号冲突改号', async () => {
    const existing = score('A', { id: 'shared-id', title: '保留编辑' })
    await repository.add(existing)

    const result = await repository.restore([
      score('A', { id: 'duplicate-content', title: '不能覆盖' }),
      score('B', { id: 'shared-id' }),
      score('C'),
    ])

    expect(result).toEqual({ added: 2, skipped: 1 })
    const records = await repository.list()
    expect(records).toHaveLength(3)
    expect(records.find((item) => item.fingerprint === SHA256.A)).toEqual(existing)
    expect(records.find((item) => item.fingerprint === SHA256.B)?.id).not.toBe('shared-id')
  })

  it('恢复前核验全部指纹，坏记录不会留下部分写入', async () => {
    await expect(repository.restore([
      score('A'),
      score('B', { fingerprint: SHA256.C }),
    ])).rejects.toThrow(/指纹/)

    expect(await repository.list()).toEqual([])
  })

  it('恢复事务中途失败时回滚已经排队的写入', async () => {
    const originalAdd = IDBObjectStore.prototype.add
    let calls = 0
    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      calls += 1
      if (calls === 2) throw new DOMException('forced failure', 'UnknownError')
      return key === undefined
        ? originalAdd.call(this, value)
        : originalAdd.call(this, value, key)
    })

    await expect(repository.restore([score('A'), score('B')])).rejects.toThrow(/保存本地曲库/)
    expect(await repository.list()).toEqual([])
  })

  it('拒绝超大记录且不创建部分状态', async () => {
    const oversized = score('A', { originalXml: 'x'.repeat(10 * 1024 * 1024 + 1) })

    await expect(repository.add(oversized)).rejects.toThrow(/10 MB/)
    expect(await repository.list()).toEqual([])
  })

  it('把打开、配额和事务故障转换为中文错误', async () => {
    vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    await expect(repository.list()).rejects.toThrow(/无法打开本地曲库/)

    vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementationOnce(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    await expect(repository.add(score('A'))).rejects.toThrow(/存储空间不足/)

    await repository.add(score('A'))
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new DOMException('failed', 'UnknownError')
    })
    await expect(repository.update('score-a', { title: '不会保存' })).rejects.toThrow(/无法保存本地曲库/)
    expect((await repository.get('score-a'))?.title).toBe('曲目 A')
  })

  it('从 v1 安全升级并把没有 folderId 的旧谱视为未分类', async () => {
    await seedVersionOne(databaseName, score('A'))

    const upgraded = createScoreRepository(databaseName)
    const folders = await upgraded.listFolders()
    const records = await upgraded.list()

    expect(folders).toEqual([])
    expect(records).toEqual([score('A')])
    expect(records[0].folderId).toBeUndefined()

    const created = await upgraded.createFolder('旧谱归档')
    await upgraded.moveScores(['score-a'], created.id)
    expect((await upgraded.get('score-a'))?.folderId).toBe(created.id)
  })

  it('创建和重命名会 trim 文件夹名并拒绝同名', async () => {
    const first = await repository.createFolder('  练习曲  ')
    const second = await repository.createFolder('收藏')

    expect(first.name).toBe('练习曲')
    await expect(repository.createFolder('练习曲')).rejects.toThrow(/同名/)
    expect((await repository.renameFolder(second.id, '  演出曲目 ')).name).toBe('演出曲目')
    await expect(repository.renameFolder(second.id, '练习曲')).rejects.toThrow(/同名/)
    expect((await repository.listFolders()).map((item) => item.name).sort()).toEqual(['演出曲目', '练习曲'])
  })

  it('批量移动先验证全部目标，删文件夹只把谱移到未分类', async () => {
    const target = await repository.createFolder('排练')
    await repository.add(score('A'))
    await repository.add(score('B'))

    await expect(repository.moveScores(['score-a', 'missing'], target.id)).rejects.toThrow(/找不到/)
    expect((await repository.list()).every((item) => !item.folderId)).toBe(true)

    await repository.moveScores(['score-a', 'score-b'], target.id)
    expect((await repository.list()).every((item) => item.folderId === target.id)).toBe(true)

    await repository.removeFolder(target.id)
    expect(await repository.listFolders()).toEqual([])
    expect((await repository.list()).map((item) => item.folderId)).toEqual([null, null])
  })

  it('新增和更新 folderId 时验证文件夹存在', async () => {
    await expect(repository.add(score('A', { folderId: 'missing' }))).rejects.toThrow(/文件夹/)
    await repository.add(score('A'))
    await expect(repository.update('score-a', { folderId: 'missing' })).rejects.toThrow(/文件夹/)

    const target = await repository.createFolder('有效目录')
    const updated = await repository.update('score-a', {
      folderId: target.id,
      coverImage: 'data:image/png;base64,AA==',
    })
    expect(updated.folderId).toBe(target.id)
    expect(updated.coverImage).toBe('data:image/png;base64,AA==')
  })

  it('摘要使用游标逐项移除 XML 和封面，封面按单条记录读取', async () => {
    await repository.add(score('A', { coverImage: 'data:image/webp;base64,AA==' }))
    await repository.add(score('B'))
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(() => {
      throw new Error('listSummaries 不应调用 getAll')
    })

    const summaries = await repository.listSummaries()

    expect(summaries).toHaveLength(2)
    expect(summaries.find((item) => item.id === 'score-a')?.hasCover).toBe(true)
    expect(summaries.find((item) => item.id === 'score-b')?.hasCover).toBe(false)
    expect(summaries.every((item) => !Object.hasOwn(item, 'originalXml'))).toBe(true)
    expect(summaries.every((item) => !Object.hasOwn(item, 'coverImage'))).toBe(true)
    expect(await repository.getCover('score-a')).toBe('data:image/webp;base64,AA==')
    expect(await repository.getCover('missing')).toBeNull()
  })

  it('拒绝远程、SVG 和解码后超过 512 KiB 的封面', async () => {
    const oversized = `data:image/jpeg;base64,${'A'.repeat(699_052)}`

    await expect(repository.add(score('A', { coverImage: 'https://example.com/cover.png' }))).rejects.toThrow(/封面/)
    await expect(repository.add(score('A', { coverImage: 'data:image/svg+xml;base64,AA==' }))).rejects.toThrow(/封面/)
    await expect(repository.add(score('A', { coverImage: oversized }))).rejects.toThrow(/512 KiB/)
    expect(await repository.list()).toEqual([])
  })

  it('恢复库时合并同名文件夹、改写 ID 冲突并保留重复谱的现有归类', async () => {
    await repository.restoreLibrary({
      folders: [folder('same-id', '现有'), folder('shared-existing', '共享')],
      records: [score('A', { id: 'score-a', title: '保留编辑', folderId: 'same-id' })],
    })
    const incoming: LibrarySnapshot = {
      folders: [
        folder('same-id', '导入冲突'),
        folder('incoming-shared', '共享'),
        folder('empty-folder', '空文件夹'),
      ],
      records: [
        score('A', { id: 'duplicate-a', title: '不能覆盖', folderId: 'empty-folder' }),
        score('B', { id: 'score-a', folderId: 'same-id' }),
        score('C', { folderId: 'incoming-shared' }),
      ],
    }

    const result = await repository.restoreLibrary(incoming)

    expect(result).toEqual({ added: 2, skipped: 1, foldersAdded: 2 })
    const snapshot = await repository.snapshot()
    expect(snapshot.folders.map((item) => item.name).sort()).toEqual(['共享', '导入冲突', '现有', '空文件夹'])
    const existing = snapshot.records.find((item) => item.fingerprint === SHA256.A)
    const restoredB = snapshot.records.find((item) => item.fingerprint === SHA256.B)
    const restoredC = snapshot.records.find((item) => item.fingerprint === SHA256.C)
    expect(existing).toMatchObject({ title: '保留编辑', folderId: 'same-id' })
    expect(restoredB?.id).not.toBe('score-a')
    expect(snapshot.folders.find((item) => item.id === restoredB?.folderId)?.name).toBe('导入冲突')
    expect(restoredC?.folderId).toBe('shared-existing')
    expect(snapshot.folders.some((item) => item.name === '空文件夹')).toBe(true)
  })

  it('恢复库会在写入前拒绝悬空文件夹引用', async () => {
    const before = await repository.snapshot()
    await expect(repository.restoreLibrary({
      folders: [folder('valid', '有效')],
      records: [score('A', { folderId: 'missing' })],
    })).rejects.toThrow(/文件夹/)

    expect(await repository.snapshot()).toEqual(before)
  })
})
