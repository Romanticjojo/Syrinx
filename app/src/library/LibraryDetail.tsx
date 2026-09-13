import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '../store'
import type { Timeline } from '../types'
import { inspectScore, prepareScore } from './score'
import type { PersonalScore, PreparedScore, ScoreInspection, ScoreSettings } from './types'
import SettingsForm from './SettingsForm'
import { activatePersonalScore } from './bridge'
import { Icon, ScoreCover } from './ui'
import { downloadLocal, errorMessage } from './library-utils'
import Dialog from '../components/Dialog'
import { createScorePaginator } from './reader'
import { normaliseSettings } from './settings'

const ScoreSheet = lazy(() => import('../components/ScoreSheet'))
const readingTimeline: Timeline = { notes: [], measureTimes: [], durationSec: 0, tempo: 120, secPerQuarter: 0.5 }

export default function LibraryDetail({ record, onBack, onEdit, onFavorite, onSave }: {
  record: PersonalScore; onBack: () => void; onEdit: () => void; onFavorite: () => void
  onSave: (settings: ScoreSettings) => Promise<PersonalScore>
}) {
  const go = useAppStore((s) => s.go)
  const [savedSettings, setSettings] = useState(record.settings)
  const [analysisState, setAnalysis] = useState<{ xml: string; snapshot: ScoreSettings; info: ScoreInspection; settings: ScoreSettings; prepared: PreparedScore | null; warning: string } | null>(null)
  const analysis = analysisState?.xml === record.originalXml && analysisState.snapshot === savedSettings ? analysisState : null
  const settings = analysis?.settings ?? savedSettings
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [kind, setKind] = useState<'full' | 'melody' | 'piano'>('melody')
  const [pagination, setPagination] = useState<{ xml: string | null; page: number }>({ xml: null, page: 0 })
  const [zoom, setZoom] = useState(1)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draft, setDraft] = useState(record.settings)
  const [settingsError, setSettingsError] = useState('')
  const [saving, setSaving] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [auditioning, setAuditioning] = useState(false)
  const alive = useRef(true)
  const operation = useRef(0)
  const preview = useRef<{ stop: () => void; cancel: () => void } | null>(null)
  const cancelPending = useCallback(() => { operation.current++; preview.current?.stop(); preview.current?.cancel() }, [])
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; cancelPending() }
  }, [cancelPending])
  useEffect(() => {
    cancelPending()
    const timer = setTimeout(() => {
      setAuditioning(false); setPreparing(false); setError('')
      try {
        const info = inspectScore(record.originalXml)
        const normalized = normaliseSettings(info, savedSettings)
        const context = { xml: record.originalXml, snapshot: savedSettings, info, settings: normalized }
        if (normalized.mode === 'none') { setAnalysis({ ...context, prepared: null, warning: '' }); return }
        try { setAnalysis({ ...context, prepared: prepareScore(record.originalXml, normalized), warning: '' }) }
        catch (e) { setAnalysis({ ...context, prepared: null, warning: errorMessage(e) }) }
      } catch (e) { setError(errorMessage(e)) }
    }, 0)
    return () => clearTimeout(timer)
  }, [record.originalXml, savedSettings, cancelPending])
  const save = async () => {
    if (saving || !analysis) return
    setSettingsError(''); setNotice(''); setSaving(true)
    try {
      const next = normaliseSettings(analysis.info, draft)
      if (next.mode === 'original') prepareScore(record.originalXml, next)
      await onSave(next)
      if (!alive.current) return
      setSettings(next); setNotice('阅读与伴奏设置已保存'); setSettingsOpen(false)
    } catch (e) { if (alive.current) setSettingsError(errorMessage(e)) }
    finally { if (alive.current) setSaving(false) }
  }
  const closeSettings = () => { if (!saving) { setDraft(settings); setSettingsError(''); setSettingsOpen(false) } }
  const play = async (audition: boolean) => {
    if (settings.mode !== 'original' || !analysis?.prepared || preparing) return
    const run = ++operation.current
    setPreparing(true); setError(''); setNotice('')
    preview.current?.stop(); preview.current?.cancel()
    try {
      const saved = await onSave(settings)
      if (!alive.current || operation.current !== run) return
      const source = activatePersonalScore(saved, analysis.prepared)
      if (!audition) { go('perform', source.manifest.id); return }
      const { audioEngine } = await import('../audio/AudioEngine')
      if (!alive.current || operation.current !== run) return
      preview.current = { stop: () => { audioEngine.pause(); audioEngine.onEnd = undefined }, cancel: source.cancelAudio }
      await audioEngine.resume()
      if (!alive.current || operation.current !== run) return
      const buffer = await source.loadAudio()
      if (!alive.current || operation.current !== run) return
      await audioEngine.load(buffer)
      if (!alive.current || operation.current !== run) return
      audioEngine.onEnd = () => { if (alive.current && operation.current === run) setAuditioning(false) }
      const started = await audioEngine.play(0)
      if (!started) throw new Error('声音尚未启用，请再次点击试听')
      if (alive.current && operation.current === run) setAuditioning(true)
    } catch (e) { if (alive.current && operation.current === run && (!(e instanceof Error) || e.name !== 'AbortError')) setError(errorMessage(e)) }
    finally { if (alive.current && operation.current === run) setPreparing(false) }
  }
  const stop = () => { operation.current++; preview.current?.stop(); preview.current?.cancel(); setAuditioning(false); setPreparing(false) }
  const prepared = analysis?.prepared
  const effectiveKind = kind === 'piano' && !prepared?.pianoXml ? (prepared ? 'melody' : 'full') : kind === 'melody' && !prepared ? 'full' : kind
  const xml = effectiveKind === 'melody' ? prepared?.melodyXml : effectiveKind === 'piano' ? prepared?.pianoXml : analysis ? record.originalXml : null
  const reader = useMemo(() => {
    if (!xml) return { paginator: null, error: '' }
    try { return { paginator: createScorePaginator(xml), error: '' } }
    catch (e) { return { paginator: null, error: errorMessage(e) } }
  }, [xml])
  const pageCount = reader.paginator?.pageCount ?? 1
  const currentPage = Math.min(pagination.xml === xml ? pagination.page : 0, pageCount - 1)
  const pageXml = reader.paginator?.page(currentPage) ?? null
  const paging = <div className="reader-pagination"><button className="btn-pill" disabled={currentPage === 0} onClick={() => setPagination({ xml: xml ?? null, page: Math.max(0, currentPage - 1) })}>上一页</button><span aria-live="polite">第 {currentPage + 1} / {pageCount} 页</span><button className="btn-pill" disabled={currentPage >= pageCount - 1} onClick={() => setPagination({ xml: xml ?? null, page: Math.min(pageCount - 1, currentPage + 1) })}>下一页</button></div>
  const length = prepared ? `${Math.floor(prepared.timeline.durationSec / 60)}:${String(Math.ceil(prepared.timeline.durationSec % 60)).padStart(2, '0')}` : ''
  return <section className="library-detail" aria-label={record.title}>
    <button className="library-back" onClick={onBack}><Icon name="back" />返回个人仓库</button>
    <div className="library-detail-hero"><ScoreCover title={record.title} composer={record.composer} mode={settings.mode} image={record.coverImage} large />
      <div className="library-detail-copy"><div className="library-eyebrow">MY SHEET MUSIC</div><h1>{record.title}</h1><p className="detail-composer">{record.composer || '未填写作曲信息'}</p>
        <div className="detail-facts"><span>{settings.mode === 'original' ? '原谱钢琴伴奏' : '仅阅谱'}</span>{analysis && <span>♩ {Math.round(analysis.info.tempo)} · {analysis.info.beats}/{analysis.info.beatType}</span>}{length && <span>{length}</span>}</div>
        <p className="library-lead">属于你的乐谱，随时翻开。原始谱面和伴奏设置都保存在这台设备。</p>
        {!!record.tags.length && <div className="library-tags">{record.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
        <div className="detail-actions">{settings.mode === 'original' && <><button className="library-primary" disabled={!prepared || preparing} onClick={() => { void play(false) }}><Icon name="play" />开始演奏</button>
          <button className="btn-pill" disabled={!prepared && !preparing} onClick={() => { if (auditioning || preparing) stop(); else void play(true) }}>{preparing ? '取消准备' : auditioning ? '停止试听' : '试听伴奏'}</button></>}
          <button className={`library-icon-button${record.favorite ? ' is-favorite' : ''}`} aria-label={record.favorite ? '取消收藏' : '收藏乐谱'} aria-pressed={record.favorite} onClick={onFavorite}><Icon name="star" /></button>
        </div>
        <div className="detail-secondary"><button disabled={!analysis} onClick={() => { stop(); setDraft(settings); setSettingsError(''); setSettingsOpen(true) }}><Icon name="edit" size={16} />阅读与伴奏设置</button><button onClick={onEdit}>编辑信息</button><button onClick={() => downloadLocal(record.originalXml, `${record.title}.musicxml`, 'application/vnd.recordare.musicxml+xml')}>导出原谱</button></div>
        {preparing && <div className="library-progress" role="status">正在本机准备钢琴伴奏…</div>}
      </div>
    </div>
    {!!notice && <div className="library-notice" role="status">{notice}</div>}
    {!!error && <div className="library-error" role="alert">{error}</div>}
    {!!analysis?.warning && <div className="library-warning" role="status">{analysis.warning} · 原谱仍可阅读。</div>}
    {!!prepared?.warnings.length && <details className="library-warnings"><summary>谱面说明（{prepared.warnings.length}）</summary>{prepared.warnings.map((warning, i) => <p key={i}>{warning}</p>)}</details>}
    <div className="reader-toolbar"><div className="reader-kinds" role="tablist" aria-label="谱面视图">{([['full', '完整谱面'], ['melody', '主旋律'], ['piano', '钢琴谱']] as const).map(([value, label]) => <button role="tab" aria-selected={effectiveKind === value} disabled={value === 'piano' ? !prepared?.pianoXml : value === 'melody' ? !prepared : false} key={value} onClick={() => setKind(value)}>{label}</button>)}</div>
      <div className="reader-zoom"><button aria-label="缩小谱面" disabled={zoom <= 0.6} onClick={() => setZoom((z) => Math.max(0.6, z - 0.1))}>−</button><span>{Math.round(zoom * 100)}%</span><button aria-label="放大谱面" disabled={zoom >= 1.8} onClick={() => setZoom((z) => Math.min(1.8, z + 0.1))}>＋</button></div></div>
    {reader.paginator && paging}
    {!!reader.error && <div className="library-error" role="alert">{reader.error}</div>}
    <div className="library-reader" aria-label="乐谱阅读区域"><Suspense fallback={<div className="library-progress">正在打开阅谱器…</div>}><ScoreSheet key={`${effectiveKind}-${currentPage}`} xml={pageXml} timeline={readingTimeline} zoom={zoom} autoScroll={false} /></Suspense></div>
    {pageCount > 1 && paging}
    {settingsOpen && analysis && <Dialog title="阅读与伴奏设置" onClose={closeSettings} wide><SettingsForm info={analysis.info} value={draft} onChange={(next) => { setDraft(next); setSettingsError('') }} /><div className="dialog-actions"><button className="btn-pill" disabled={saving} onClick={closeSettings}>取消</button><button className="library-primary" onClick={() => { void save() }} disabled={saving}>{saving ? '正在保存…' : '保存设置'}</button></div>{!!settingsError && <div className="library-error" role="alert">{settingsError}</div>}</Dialog>}
  </section>
}
