import { useEffect, useRef, useState } from 'react'
import Dialog from '../components/Dialog'
import { readScoreFile } from './files'
import { inspectScore, prepareScore } from './score'
import { scoreRepository } from './repository'
import type { PersonalScore, ScoreFolder, ScoreInspection, ScoreSettings } from './types'
import SettingsForm from './SettingsForm'
import { initialSettings } from './settings'
import { Icon } from './ui'
import { errorMessage } from './library-utils'

export default function LibraryImport({ files, folders, defaultFolderId, onClose, onSaved }: { files: File[]; folders: ScoreFolder[]; defaultFolderId: string | null; onClose: () => void; onSaved: (record: PersonalScore, duplicate: boolean) => void }) {
  const [index, setIndex] = useState(0)
  const [input, setInput] = useState<{ xml: string; info: ScoreInspection; fingerprint: string } | null>(null)
  const [settings, setSettings] = useState<ScoreSettings | null>(null)
  const [title, setTitle] = useState('')
  const [composer, setComposer] = useState('')
  const [folderId, setFolderId] = useState(defaultFolderId)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const alive = useRef(true)
  const file = files[index]
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let current = true
    void (async () => {
      try {
        const xml = await readScoreFile(file)
        const info = inspectScore(xml)
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(xml))
        const fingerprint = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
        if (!current) return
        setInput({ xml, info, fingerprint }); setSettings(initialSettings(info))
        setTitle(info.title && info.title !== '未命名乐谱' ? info.title : file.name.replace(/\.(musicxml|xml|mxl)$/i, '')); setComposer(info.composer)
      } catch (e) { if (current) setError(errorMessage(e)) }
    })()
    return () => { current = false }
  }, [file])
  const next = () => { if (index + 1 < files.length) { setInput(null); setSettings(null); setError(''); setIndex(index + 1) } else onClose() }
  const save = async () => {
    if (!input || !settings || saving) return
    setSaving(true); setError('')
    try {
      if (!title.trim()) throw new Error('请填写乐谱名称')
      if (settings.mode !== 'none') prepareScore(input.xml, settings)
      const now = Date.now()
      const result = await scoreRepository.add({ id: crypto.randomUUID(), fingerprint: input.fingerprint, originalXml: input.xml, title: title.trim(), composer: composer.trim(), tags: [], favorite: false, createdAt: now, updatedAt: now, lastOpenedAt: null, settings, folderId })
      if (!alive.current) return
      onSaved(result.record, result.duplicate); next()
    } catch (e) { if (alive.current) setError(errorMessage(e)) }
    finally { if (alive.current) setSaving(false) }
  }
  return <Dialog title="导入乐谱" onClose={() => { if (!saving) onClose() }} wide>
    <div className="import-file"><Icon name="sheet" size={25} /><div><strong>{file.name}</strong><span>{(file.size / 1024).toFixed(0)} KB · 仅保存到这台设备{files.length > 1 ? ` · ${index + 1} / ${files.length}` : ''}</span></div></div>
    {!input && !error && <div className="library-progress" role="status">正在读取谱面与声部…</div>}
    {input && settings && <><div className="form-row"><label className="library-field">乐谱名称<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} /></label><label className="library-field">作曲 / 编曲<input value={composer} onChange={(e) => setComposer(e.target.value)} maxLength={200} placeholder="可不填写" /></label></div>
      <div className="import-facts"><span>{input.info.parts.length} 个声部</span><span>{input.info.beats}/{input.info.beatType} 拍</span><span>♩ = {Math.round(input.info.tempo)}</span></div>
      <label className="library-field import-folder">保存到文件夹<select aria-label="保存到文件夹" value={folderId || ''} onChange={(e) => setFolderId(e.target.value || null)}><option value="">未分类</option>{folders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <SettingsForm info={input.info} value={settings} onChange={setSettings} />
      {!!input.info.warnings.length && <div className="library-warning">{input.info.warnings.map((warning) => <p key={warning}>{warning}</p>)}</div>}
    </>}
    {!!error && <div className="library-error" role="alert">{error}{input && <p>可以选择“仅阅谱”先保存并阅读原谱。</p>}</div>}
    <div className="dialog-actions"><button className="btn-pill" onClick={next} disabled={saving}>{files.length > 1 ? '跳过这份' : '取消'}</button><button className="library-primary" onClick={() => { void save() }} disabled={!input || !settings || !title.trim() || saving}><Icon name="add" />{saving ? '正在保存…' : '加入个人仓库'}</button></div>
  </Dialog>
}
