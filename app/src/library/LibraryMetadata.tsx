import { useEffect, useRef, useState } from 'react'
import Dialog from '../components/Dialog'
import type { PersonalScore, ScoreFolder } from './types'
import { errorMessage } from './library-utils'
import CoverEditor from './CoverEditor'

export default function LibraryMetadata({ record, folders, onClose, onSave }: {
  record: PersonalScore; folders: ScoreFolder[]; onClose: () => void
  onSave: (patch: { title: string; composer: string; tags: string[]; folderId: string | null; coverImage: string | null }) => Promise<void>
}) {
  const [title, setTitle] = useState(record.title)
  const [composer, setComposer] = useState(record.composer)
  const [tags, setTags] = useState(record.tags.join('，'))
  const [folderId, setFolderId] = useState<string | null>(record.folderId ?? null)
  const [coverImage, setCoverImage] = useState<string | null>(record.coverImage ?? null)
  const [coverBusy, setCoverBusy] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const submit = async () => {
    if (busy || coverBusy) return
    setBusy(true); setError('')
    try {
      await onSave({ title: title.trim(), composer: composer.trim(), tags: [...new Set(tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))], folderId, coverImage })
      if (mounted.current) onClose()
    } catch (e) { if (mounted.current) setError(errorMessage(e)) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <Dialog title="编辑乐谱信息" onClose={() => { if (!busy) onClose() }}>
    <CoverEditor value={coverImage} title={title} onChange={setCoverImage} disabled={busy} onBusyChange={setCoverBusy} />
    <div className="metadata-fields"><label className="library-field">乐谱名称<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></label><label className="library-field">作曲 / 编曲<input value={composer} onChange={(e) => setComposer(e.target.value)} maxLength={200} /></label><label className="library-field">标签<input value={tags} onChange={(e) => setTags(e.target.value)} maxLength={400} placeholder="例如：练习，最喜欢的旋律" /></label><p className="field-hint">用逗号分隔，之后可以按标签查找。</p></div>
    <label className="library-field">所在文件夹<select value={folderId ?? ''} disabled={busy} onChange={(event) => setFolderId(event.target.value || null)}><option value="">未分类</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label>
    {!!error && <div className="library-error" role="alert">{error}</div>}
    <div className="dialog-actions"><button className="btn-pill" disabled={busy} onClick={onClose}>取消</button><button className="library-primary" disabled={!title.trim() || busy || coverBusy} onClick={() => { void submit() }}>{busy ? '正在保存…' : '保存信息'}</button></div>
  </Dialog>
}
