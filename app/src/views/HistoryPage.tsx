import { useCallback, useEffect, useRef, useState } from 'react'
import { clearPractices, deletePractice, getPractice, listPractices, type StoredPractice } from '../practice/history'
import { downloadPracticeBlob } from '../practice/service'
import { getSong } from '../songs'
import { useAppStore } from '../store'
import './HistoryPage.css'

type Row = Omit<StoredPractice, 'audioBlob' | 'pitchTrack'>
export default function HistoryPage() {
  const go = useAppStore(s => s.go)
  const openPractice = useAppStore(s => s.openPractice)
  const [rows, setRows] = useState<Row[]>([])
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const generation = useRef(0)
  const refresh = useCallback(async (id: number) => {
    const records = await listPractices()
    if (id !== generation.current) return
    setRows(records.map(({ audioBlob: _blob, pitchTrack: _track, ...row }) => row))
  }, [])
  useEffect(() => {
    const id = ++generation.current
    void refresh(id).catch(e => { if (id === generation.current) setError(String(e)) })
      .finally(() => { if (id === generation.current) setLoading(false) })
    // This ref is an operation generation, not a DOM node. Invalidate pending reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { generation.current++ }
  }, [refresh])
  const run = async (action: (id: number) => Promise<void>) => {
    if (busy) return
    const id = ++generation.current
    setBusy(true); setError('')
    try { await action(id) }
    catch (e) { if (id === generation.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { if (id === generation.current) { setBusy(false); setLoading(false) } }
  }
  const open = (sessionId: string, download = false) => void run(async id => {
    const record = await getPractice(sessionId)
    if (id !== generation.current) return
    if (!record) throw new Error('这条记录已不存在，请刷新列表。')
    if (download) downloadPracticeBlob(record, record.audioBlob)
    else openPractice({ ...record, audioUrl: URL.createObjectURL(record.audioBlob) })
  })
  const remove = () => void run(async id => {
    if (confirm === 'all') await clearPractices()
    else if (confirm) await deletePractice(confirm)
    if (id !== generation.current) return
    setConfirm(null)
    await refresh(id)
  })
  const songs = [...new Set(rows.map(r => r.songId))]
  return <main className="history-page">
    <header><button className="btn-pill" onClick={() => go('home')}>返回曲库</button><h1>练习记录</h1></header>
    <p className="history-note">录音仅保存在当前浏览器和网址，不会上传。清理浏览器数据会移除记录，重要录音请下载保存。</p>
    <div className="history-tools">
      <label>按曲目浏览 <select aria-label="按曲目浏览" value={filter} onChange={e => setFilter(e.target.value)}><option value="">全部曲目</option>{songs.map(id => <option key={id} value={id}>{getSong(id)?.title ?? id}</option>)}</select></label>
      <button className="btn-pill" disabled={busy || loading} onClick={() => void run(refresh)}>刷新记录</button>
      <button className="btn-pill" disabled={busy || !rows.length} onClick={() => setConfirm('all')}>清空记录</button>
    </div>
    {error && <p className="history-error" role="alert">记录存储不可用：{error}。请重试；现有录音不会被自动删除。</p>}
    {loading ? <p role="status">正在读取练习记录…</p> : rows.length === 0 ? <div className="history-empty">还没有练习记录。完成一次录音后会自动保存在这里。</div> : <div className="history-list">{rows.filter(r => !filter || r.songId === filter).map(row => <article key={row.sessionId}>
      <div><h2>{getSong(row.songId)?.title ?? row.songId}</h2><p>{new Date(row.startedAt).toLocaleString('zh-CN')} · {row.practice.range ? `第 ${row.practice.range.startMeasure}–${row.practice.range.endMeasure} 小节` : '整曲'} · 第 {row.practice.round} / {row.practice.rounds} 轮</p><p>{row.durationSec.toFixed(1)} 秒 · {row.stats ? '已分析' : '打开后分析'}</p></div>
      <div className="history-row-actions"><button className="btn-pill" disabled={busy} onClick={() => open(row.sessionId)}>打开回放</button><button className="btn-pill" disabled={busy} onClick={() => open(row.sessionId, true)}>下载原录音</button><button className="btn-pill" disabled={busy} onClick={() => setConfirm(row.sessionId)}>删除</button></div>
    </article>)}</div>}
    {confirm && <div className="history-confirm" role="alertdialog" aria-modal="true" aria-label={confirm === 'all' ? '清空练习记录' : '删除练习记录'}><div><h2>{confirm === 'all' ? '清空全部练习记录？' : '删除这条练习记录？'}</h2><p>删除后无法恢复，请先下载需要保留的录音。</p><button className="btn-pill" disabled={busy} onClick={() => setConfirm(null)}>取消</button><button className="btn-pill" disabled={busy} onClick={remove}>{confirm === 'all' ? '确认清空' : '确认删除'}</button>{error && <p role="alert">{error}</p>}</div></div>}
  </main>
}
