import { useCallback, useEffect, useRef, useState } from 'react'
import Dialog from '../components/Dialog'
import type { LibrarySnapshot, PersonalScore, PersonalScoreSummary, ScoreFolder } from './types'
import { scoreRepository } from './repository'
import { decodeLibraryBackup, encodeLibraryBackupParts, type BackupPart } from './backup'
import LibraryImport from './LibraryImport'
import LibraryDetail from './LibraryDetail'
import LibraryMetadata from './LibraryMetadata'
import LibraryMenu from './LibraryMenu'
import { Icon, ScoreCover } from './ui'
import { downloadLocal, errorMessage } from './library-utils'
import './library.css'

function summarize(record: PersonalScore): PersonalScoreSummary {
  const { originalXml: _xml, coverImage: _cover, ...summary } = record
  return { ...summary, hasCover: !!record.coverImage }
}
function savedView(): 'grid' | 'list' {
  try { return localStorage.getItem('syrinx-library-view') === 'list' ? 'list' : 'grid' }
  catch { return 'grid' }
}
function ScoreArtwork({ score }: { score: PersonalScoreSummary }) {
  const [cover, setCover] = useState<{ key: string; image: string | null } | null>(null)
  const key = `${score.id}/${score.updatedAt}`
  useEffect(() => {
    if (!score.hasCover) return
    let current = true
    void scoreRepository.getCover(score.id).then((image) => { if (current) setCover({ key, image }) }).catch(() => {})
    return () => { current = false }
  }, [score.id, score.hasCover, key])
  return <ScoreCover title={score.title} composer={score.composer} mode={score.settings.mode} image={score.hasCover && cover?.key === key ? cover.image : null} />
}
function LibraryItem({ score, list, checked, selecting, onSelect, onOpen, onEdit, onMove, onDelete, onFavorite }: {
  score: PersonalScoreSummary; list: boolean; checked: boolean; selecting: boolean
  onSelect: () => void; onOpen: () => void; onEdit: () => void; onMove: () => void; onDelete: () => void; onFavorite: () => void
}) {
  return <article className={`${list ? 'library-list-row' : 'library-card'}${checked ? ' is-selected' : ''}${selecting ? ' is-selecting' : ''}`}>
    {selecting && <label className="library-select-score"><input type="checkbox" aria-label={`选择 ${score.title}`} checked={checked} onChange={onSelect} /><span>选择</span></label>}
    <button className="library-card-open" onClick={selecting ? onSelect : onOpen} aria-label={`${selecting ? '选择乐谱' : '打开'} ${score.title}`}><ScoreArtwork score={score} />{!list && !selecting && <span className="library-card-open-hint"><Icon name="sheet" />翻开乐谱</span>}</button>
    <div className="library-item-description"><div className="library-card-info"><button className="library-title-button" onClick={selecting ? onSelect : onOpen} title={score.title}>{score.title}</button>{score.favorite && <span className="library-favorite-mark" aria-label="已收藏"><Icon name="star" size={13} /></span>}</div>
      {score.composer && <p className="library-card-composer">{score.composer}</p>}
    </div>
    {!selecting && <LibraryMenu label={`${score.title} 的更多操作`} items={[
      { label: '编辑信息', onSelect: onEdit },
      { label: '移动到文件夹', onSelect: onMove },
      { label: score.favorite ? '取消收藏' : '收藏乐谱', onSelect: onFavorite },
      { label: '移除乐谱', onSelect: onDelete, danger: true, divider: true },
    ]} />}
  </article>
}

export default function PersonalLibrary() {
  const [scores, setScores] = useState<PersonalScoreSummary[]>([])
  const [folders, setFolders] = useState<ScoreFolder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [record, setRecord] = useState<PersonalScore | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'favorites'>('all')
  const [folder, setFolder] = useState<string | null>(null)
  const [sort, setSort] = useState('newest')
  const [view, setView] = useState(savedView)
  const [page, setPage] = useState(0)
  const [checked, setChecked] = useState<string[]>([])
  const [selecting, setSelecting] = useState(false)
  const [moving, setMoving] = useState<string[] | null>(null)
  const [targetFolder, setTargetFolder] = useState('')
  const [folderEditor, setFolderEditor] = useState<{ id?: string; name: string } | null>(null)
  const [folderToRemove, setFolderToRemove] = useState<ScoreFolder | null>(null)
  const [files, setFiles] = useState<File[]>([])
  const [editing, setEditing] = useState<PersonalScore | null>(null)
  const [removing, setRemoving] = useState<PersonalScoreSummary | null>(null)
  const [restore, setRestore] = useState<LibrarySnapshot | null>(null)
  const [exports, setExports] = useState<BackupPart[]>([])
  const [downloaded, setDownloaded] = useState<number[]>([])
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const backupInput = useRef<HTMLInputElement>(null)
  const toolbar = useRef<HTMLDivElement>(null)
  const mounted = useRef(true)
  const readGeneration = useRef(0)
  const editGeneration = useRef(0)
  const openGeneration = useRef(0)
  const refresh = useCallback(async () => {
    const generation = ++readGeneration.current
    try {
      const [records, collections] = await Promise.all([scoreRepository.listSummaries(), scoreRepository.listFolders()])
      if (mounted.current && readGeneration.current === generation) { setScores(records); setFolders(collections); setError('') }
    } catch (e) { if (mounted.current) setError(errorMessage(e)) }
    finally { if (mounted.current) setLoading(false) }
  }, [])
  useEffect(() => {
    mounted.current = true
    const timer = setTimeout(() => { void refresh() }, 0)
    return () => { clearTimeout(timer); mounted.current = false }
  }, [refresh])
  const update = async (id: string, patch: Parameters<typeof scoreRepository.update>[1]) => {
    const saved = await scoreRepository.update(id, patch)
    if (mounted.current) {
      setScores((items) => items.map((item) => item.id === saved.id ? summarize(saved) : item))
      setRecord((current) => current?.id === id ? saved : current)
    }
    return saved
  }
  const open = async (score: PersonalScoreSummary) => {
    const generation = ++openGeneration.current
    setNotice(''); setError('')
    try {
      // oxlint-disable-next-line react/purity -- Timestamp is recorded only from a score-open click handler.
      const saved = await update(score.id, { lastOpenedAt: Date.now() })
      if (mounted.current && openGeneration.current === generation) { setRecord(saved); window.scrollTo(0, 0) }
    } catch (e) { if (mounted.current && openGeneration.current === generation) setError(errorMessage(e)) }
  }
  const edit = async (id: string) => {
    const generation = ++editGeneration.current
    try {
      const full = await scoreRepository.get(id)
      if (!mounted.current || editGeneration.current !== generation) return
      if (!full) throw new Error('这份乐谱已不在仓库中。')
      setEditing(full)
    } catch (e) { if (mounted.current && editGeneration.current === generation) setError(errorMessage(e)) }
  }
  const favorite = async (score: PersonalScoreSummary) => {
    try { await update(score.id, { favorite: !score.favorite }) }
    catch (e) { setError(errorMessage(e)) }
  }
  const resetPage = () => { setPage(0); setChecked([]) }
  const turnPage = (next: number) => {
    setPage(next)
    toolbar.current?.scrollIntoView({ block: 'start' })
  }
  const chooseFolder = (id: string | null) => { setFolder(id); resetPage() }
  const chooseView = (next: 'grid' | 'list') => {
    setView(next); resetPage()
    try { localStorage.setItem('syrinx-library-view', next) } catch { /* Viewing still works when preferences cannot be persisted. */ }
  }
  const selectFiles = (items: File[]) => {
    if (!items.length) return
    if (items.length > 50) { setError('每次最多导入 50 份乐谱，请分批选择。'); return }
    setError(''); setFiles(items)
  }
  const exportBackup = async () => {
    setBusy(true); setError('')
    try { setExports(encodeLibraryBackupParts(await scoreRepository.snapshot())); setDownloaded([]) }
    catch (e) { setError(errorMessage(e)) }
    finally { setBusy(false) }
  }
  const readBackup = async (file: File) => {
    setBusy(true); setError('')
    try {
      if (file.size > 100 * 1024 * 1024) throw new Error('单卷备份不能超过 100 MB。')
      const snapshot = decodeLibraryBackup(await file.text())
      if (mounted.current) setRestore(snapshot)
    } catch (e) { if (mounted.current) setError(errorMessage(e)) }
    finally { if (mounted.current) setBusy(false) }
  }
  const restoreBackup = async () => {
    if (!restore || busy) return
    setBusy(true); setError('')
    try {
      const result = await scoreRepository.restoreLibrary(restore)
      await refresh(); setRestore(null); resetPage()
      setNotice(`已恢复 ${result.added} 份乐谱和 ${result.foldersAdded} 个文件夹，保留 ${result.skipped} 份已有乐谱。`)
    } catch (e) { setError(errorMessage(e)) }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (!removing || busy) return
    setBusy(true); setError('')
    try {
      await scoreRepository.remove(removing.id)
      setScores((items) => items.filter((item) => item.id !== removing.id)); setChecked((ids) => ids.filter((id) => id !== removing.id)); setRemoving(null)
      setNotice('已从个人仓库移除，导入前的原文件不受影响。')
    } catch (e) { setError(errorMessage(e)) }
    finally { setBusy(false) }
  }
  const saveFolder = async () => {
    if (!folderEditor || busy) return
    setBusy(true); setError('')
    try {
      if (folderEditor.id) await scoreRepository.renameFolder(folderEditor.id, folderEditor.name.trim())
      else await scoreRepository.createFolder(folderEditor.name.trim())
      await refresh(); setNotice(folderEditor.id ? '文件夹已重命名。' : '文件夹已创建，可以将多份乐谱移入其中。'); setFolderEditor(null)
    } catch (e) { setError(errorMessage(e)) }
    finally { setBusy(false) }
  }
  const removeFolder = async () => {
    if (!folderToRemove || busy) return
    setBusy(true); setError('')
    try { await scoreRepository.removeFolder(folderToRemove.id); await refresh(); chooseFolder(''); setFolderToRemove(null); setNotice('文件夹已移除，其中的乐谱保留在“未分类”。') }
    catch (e) { setError(errorMessage(e)) }
    finally { setBusy(false) }
  }
  const move = async () => {
    if (!moving || busy) return
    setBusy(true); setError('')
    try { await scoreRepository.moveScores(moving, targetFolder || null); await refresh(); setNotice(`已移动 ${moving.length} 份乐谱。`); setMoving(null); setChecked([]); setSelecting(false) }
    catch (e) { setError(errorMessage(e)) }
    finally { setBusy(false) }
  }
  const beginMove = (ids: string[]) => { setMoving(ids); setTargetFolder(folder ?? ''); setError('') }
  const activeFolder = folders.find((item) => item.id === folder)
  const lowerQuery = query.trim().toLocaleLowerCase()
  const inFolder = (score: PersonalScoreSummary) => folder === null || (score.folderId || '') === folder
  const folderScores = scores.filter(inFolder)
  const filtered = folderScores.filter((score) => (filter !== 'favorites' || score.favorite) && (!lowerQuery || [score.title, score.composer, ...score.tags].join(' ').toLocaleLowerCase().includes(lowerQuery))).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title, 'zh-CN') : sort === 'opened' ? (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0) : b.createdAt - a.createdAt)
  const pageSize = view === 'grid' ? 24 : 50
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  return <div className="personal-library" onDragOver={(e) => { if (!record && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true) } }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false) }} onDrop={(e) => { e.preventDefault(); setDragging(false); if (!record && !files.length) selectFiles([...e.dataTransfer.files]) }}>
    <input ref={fileInput} className="library-file-input" type="file" accept=".musicxml,.xml,.mxl" multiple aria-label="选择 MusicXML 乐谱文件" onChange={(e) => { selectFiles([...e.target.files ?? []]); e.target.value = '' }} />
    <input ref={backupInput} className="library-file-input" type="file" accept=".json,application/json" aria-label="选择仓库备份文件" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void readBackup(file) }} />
    {record ? <LibraryDetail key={record.id} record={record} onBack={() => setRecord(null)} onEdit={() => { void edit(record.id) }} onFavorite={() => { void favorite(summarize(record)) }} onSave={(settings) => update(record.id, { settings })} /> : <>
      <header className="library-heading">
        <h1>个人仓库<span>{scores.length} 份乐谱</span></h1>
        <div className="library-heading-actions">
          <button className="library-primary" disabled={loading} onClick={() => fileInput.current?.click()}><Icon name="add" />导入乐谱</button>
          <LibraryMenu label="仓库选项" disabled={busy || loading} items={[
            { label: '选择乐谱', disabled: !scores.length, onSelect: () => { setSelecting(true); setChecked([]) } },
            { label: '新建文件夹', onSelect: () => { setFolderEditor({ name: '' }); setError('') } },
            ...(activeFolder ? [
              { label: '重命名文件夹', onSelect: () => { setFolderEditor({ id: activeFolder.id, name: activeFolder.name }); setError('') } },
              { label: '移除文件夹', onSelect: () => { setFolderToRemove(activeFolder); setError('') } },
            ] : []),
            { label: '导出备份', divider: true, onSelect: () => { void exportBackup() } },
            { label: '从备份恢复', onSelect: () => backupInput.current?.click() },
          ]} />
        </div>
      </header>
      {!!error && <div className="library-error" role="alert">{error}<button onClick={() => { setError(''); void refresh() }}>重试</button></div>}
      {!!notice && <div className="library-notice" role="status"><Icon name="check" />{notice}<button aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div>}
      {!loading && (scores.length > 0 || folders.length > 0) && (
        <div ref={toolbar} className="library-toolbar">
          <label className="library-search"><Icon name="search" size={18} /><input aria-label="搜索个人乐谱" placeholder="搜索曲名、作者" value={query} onChange={(e) => { setQuery(e.target.value); resetPage() }} /></label>
          <label className="library-folder-picker"><Icon name="folder" size={17} /><select aria-label="浏览文件夹" value={folder ?? '__all'} onChange={(e) => chooseFolder(e.target.value === '__all' ? null : e.target.value)}>
            <option value="__all">全部乐谱</option><option value="">未分类</option>{folders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          <div className="library-toolbar-options">
            <button className={`library-menu-trigger${filter === 'favorites' ? ' is-active' : ''}`} aria-label="只看收藏" title="只看收藏" aria-pressed={filter === 'favorites'} onClick={() => { setFilter(filter === 'favorites' ? 'all' : 'favorites'); resetPage() }}><Icon name="star" size={18} /></button>
            <LibraryMenu label="乐谱排序" items={[
              { label: '最近加入', selected: sort === 'newest', onSelect: () => { setSort('newest'); resetPage() } },
              { label: '最近打开', selected: sort === 'opened', onSelect: () => { setSort('opened'); resetPage() } },
              { label: '按名称', selected: sort === 'title', onSelect: () => { setSort('title'); resetPage() } },
            ]}><Icon name="sort" size={18} /></LibraryMenu>
            <div className="library-view-switch" role="group" aria-label="浏览方式"><button aria-label="卡片视图" title="卡片视图" aria-pressed={view === 'grid'} onClick={() => chooseView('grid')}><Icon name="grid" size={16} /></button><button aria-label="列表视图" title="列表视图" aria-pressed={view === 'list'} onClick={() => chooseView('list')}><Icon name="list" size={16} /></button></div>
          </div>
        </div>
      )}
      {loading ? <div className="library-progress" role="status">正在打开你的乐谱库…</div> : scores.length === 0 && folder === null ? <div className="library-empty">
        <div className="library-empty-copy"><h2>你的乐谱，随身收藏。</h2><p>导入 MusicXML，开始阅读与练习。</p><button className="library-primary" onClick={() => fileInput.current?.click()}><Icon name="add" />导入第一份乐谱</button><div className="empty-formats">MusicXML · XML · MXL<span>也可以将文件拖到这里</span></div></div>
        <div className="empty-books" aria-hidden="true"><div className="empty-book-back" /><ScoreCover title="你的下一首" composer="A COLLECTION OF YOUR OWN" large /></div>
      </div> : <>
        {selecting && <div className="library-selection-bar" role="region" aria-label="整理乐谱">
          <span aria-live="polite">已选 {checked.length} 份</span>
          <button className="text-button" disabled={!visible.length} onClick={() => setChecked((previous) => [...new Set([...previous, ...visible.map((score) => score.id)])])}>选择本页</button>
          <button className="text-button" disabled={!checked.length} onClick={() => beginMove(checked)}>移动到文件夹</button>
          <button className="btn-pill" onClick={() => { setSelecting(false); setChecked([]) }}>完成整理</button>
        </div>}
        {(filter === 'favorites' || lowerQuery) && <div className="library-result-summary"><span>{filter === 'favorites' ? '收藏乐谱 · ' : ''}{filtered.length} 份{lowerQuery ? '搜索结果' : ''}</span><button className="text-button" onClick={() => { setFilter('all'); setQuery(''); resetPage() }}>清除筛选</button></div>}
        {visible.length ? <div className={view === 'grid' ? 'library-grid' : 'library-list'}>{visible.map((score) => <LibraryItem key={score.id} score={score} list={view === 'list'} checked={checked.includes(score.id)} selecting={selecting} onSelect={() => setChecked((ids) => ids.includes(score.id) ? ids.filter((id) => id !== score.id) : [...ids, score.id])} onOpen={() => { void open(score) }} onEdit={() => { void edit(score.id) }} onMove={() => beginMove([score.id])} onDelete={() => { setRemoving(score); setError('') }} onFavorite={() => { void favorite(score) }} />)}</div> : <div className="library-no-results"><Icon name={folder !== null && !query ? 'folder' : 'search'} size={30} /><h3>{folder !== null && !query && filter === 'all' ? '这个文件夹还没有乐谱' : filter === 'favorites' && !query ? '把喜欢的乐谱留在这里' : '还没有找到这段旋律'}</h3><p>{folder !== null && !query ? '可以导入乐谱，或从全部乐谱中批量移入。' : '试试其他曲名、作者或标签。'}</p><button className="btn-pill" onClick={() => { setQuery(''); setFilter('all'); chooseFolder(null) }}>查看全部乐谱</button></div>}
        {pageCount > 1 && <nav className="reader-pagination" aria-label="仓库分页"><button className="btn-pill" disabled={currentPage === 0} onClick={() => turnPage(currentPage - 1)}>上一页</button><span aria-live="polite">{currentPage + 1} / {pageCount} 页 · {filtered.length} 份</span><button className="btn-pill" disabled={currentPage + 1 >= pageCount} onClick={() => turnPage(currentPage + 1)}>下一页</button></nav>}
      </>}
      <footer className="library-footer"><span><Icon name="lock" size={14} />保存在此设备</span></footer>
    </>}
    {dragging && <div className="library-dropzone"><Icon name="upload" size={40} /><strong>松开，将乐谱带进来</strong><span>文件仅保存在本机</span></div>}
    {files.length > 0 && <LibraryImport files={files} folders={folders} defaultFolderId={folder || null} onClose={() => setFiles([])} onSaved={(saved, duplicate) => { setNotice(duplicate ? `“${saved.title}”已在仓库，保留已有信息。` : `“${saved.title}”已加入个人仓库。`); void refresh() }} />}
    {editing && <LibraryMetadata key={editing.id} record={editing} folders={folders} onClose={() => { editGeneration.current++; setEditing(null) }} onSave={async (patch) => { await update(editing.id, patch); setNotice('乐谱信息已保存') }} />}
    {removing && <Dialog title="移除这份乐谱？" onClose={() => { if (!busy) setRemoving(null) }}><p>“{removing.title}”将从个人仓库移除。你导入前的原文件会保留；已导出的备份也可以恢复这份乐谱。</p><div className="dialog-actions"><button className="btn-pill" disabled={busy} onClick={() => setRemoving(null)}>保留乐谱</button><button className="library-primary" disabled={busy} onClick={() => { void remove() }}>{busy ? '正在移除…' : '确认移除'}</button></div>{!!error && <div className="library-error" role="alert">{error}</div>}</Dialog>}
    {folderEditor && <Dialog title={folderEditor.id ? '重命名文件夹' : '新建文件夹'} onClose={() => { if (!busy) setFolderEditor(null) }}><form onSubmit={(e) => { e.preventDefault(); void saveFolder() }}><label className="library-field">文件夹名称<input aria-label="文件夹名称" value={folderEditor.name} maxLength={80} placeholder="例如：每日练习、电影配乐" onChange={(e) => setFolderEditor({ ...folderEditor, name: e.target.value })} /></label><div className="dialog-actions"><button type="button" className="btn-pill" disabled={busy} onClick={() => setFolderEditor(null)}>取消</button><button className="library-primary" disabled={busy || !folderEditor.name.trim()}>{busy ? '正在保存…' : folderEditor.id ? '保存名称' : '创建文件夹'}</button></div></form>{!!error && <div className="library-error" role="alert">{error}</div>}</Dialog>}
    {folderToRemove && <Dialog title="移除文件夹？" onClose={() => { if (!busy) setFolderToRemove(null) }}><p>移除“{folderToRemove.name}”后，其中的乐谱会保留在“未分类”，封面和作者信息都会保留。</p><div className="dialog-actions"><button className="btn-pill" disabled={busy} onClick={() => setFolderToRemove(null)}>保留文件夹</button><button className="library-primary" disabled={busy} onClick={() => { void removeFolder() }}>确认移除文件夹</button></div>{!!error && <div className="library-error" role="alert">{error}</div>}</Dialog>}
    {moving && <Dialog title={`移动 ${moving.length} 份乐谱`} onClose={() => { if (!busy) setMoving(null) }}><label className="library-field">目标文件夹<select aria-label="目标文件夹" value={targetFolder} onChange={(e) => setTargetFolder(e.target.value)}><option value="">未分类</option>{folders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="dialog-actions"><button className="btn-pill" disabled={busy} onClick={() => setMoving(null)}>取消</button><button className="library-primary" disabled={busy} onClick={() => { void move() }}>确认移动</button></div>{!!error && <div className="library-error" role="alert">{error}</div>}</Dialog>}
    {restore && <Dialog title="恢复个人仓库" onClose={() => { if (!busy) setRestore(null) }}><p>备份包含 {restore.records.length} 份乐谱和 {restore.folders.length} 个文件夹。恢复时与当前仓库合并，重复乐谱保留已有的信息与归类。</p><div className="dialog-actions"><button className="btn-pill" disabled={busy} onClick={() => setRestore(null)}>取消</button><button className="library-primary" disabled={busy} onClick={() => { void restoreBackup() }}>{busy ? '正在恢复…' : '恢复到个人仓库'}</button></div>{!!error && <div className="library-error" role="alert">{error}</div>}</Dialog>}
    {exports.length > 0 && <Dialog title="保存仓库备份" onClose={() => setExports([])}><p>备份包含乐谱、封面、文件夹和所有编辑信息。{exports.length > 1 ? `已整理为 ${exports.length} 卷，请逐一保存，恢复时依次导入。` : '点击下方按钮保存到本机。'}</p><div className="backup-parts">{exports.map((part, index) => <button className="btn-pill" key={index} onClick={() => { downloadLocal(part.text, `Syrinx-个人仓库-${new Date().toISOString().slice(0, 10)}${exports.length > 1 ? `-${index + 1}共${exports.length}卷` : ''}.json`, 'application/json'); setDownloaded((items) => [...new Set([...items, index])]) }}><Icon name={downloaded.includes(index) ? 'check' : 'download'} />{exports.length > 1 ? `第 ${index + 1} 卷 · ` : '下载备份 · '}{part.count} 份乐谱{downloaded.includes(index) ? ' · 已发起下载' : ''}</button>)}</div><p className="field-hint">请在浏览器下载记录中确认文件已保存，再关闭此窗口。</p><div className="dialog-actions"><button className="library-primary" onClick={() => setExports([])}>完成</button></div></Dialog>}
  </div>
}
