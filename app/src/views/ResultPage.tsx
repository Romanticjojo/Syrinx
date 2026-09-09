import { useCallback, useEffect, useRef, useState } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { encodeWav } from '../audio/wav'
import PlaybackDeck from '../components/PlaybackDeck'
import PitchChart from '../components/PitchChart'
import { extractPitchTrackAsync, scoreAgainst, timelineInRange, type ScoreResult } from '../pitch/compare'
import { getSong, loadSong } from '../songs'
import { assetUrl } from '../lib/assetUrl'
import { useAppStore } from '../store'
import { loadAccompaniment } from '../audio/accompaniment'
import { listPractices, updatePracticeAnalysis, type StoredPractice } from '../practice/history'
import { comparisonReason, songVersion, weakMeasures, SCORING_VERSION } from '../practice/model'
import { downloadPracticeBlob } from '../practice/service'
import type { Timeline, TuneStats } from '../types'
import './ResultPage.css'

type Analysis =
  | { status: 'analyzing' }
  | { status: 'incompatible'; message: string }
  | { status: 'done'; result: ScoreResult }
  | { status: 'unsupported'; message: string }
  | { status: 'error'; message: string }

const fmt = (sec: number): string =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

export default function ResultPage() {
  const session = useAppStore((s) => s.performanceSession)
  const take = session?.status === 'completed' ? session.take : null
  const takeSessionId = take?.sessionId
  const takeAudioUrl = take?.audioUrl
  const takeStartSec = take?.startSec
  const currentSongId = useAppStore((s) => s.currentSongId)
  const songId = session?.songId ?? currentSongId
  const go = useAppStore((s) => s.go)
  const cacheTakeAnalysis = useAppStore((s) => s.cacheTakeAnalysis)
  const song = getSong(songId)
  const accent = song?.accent ?? '#61c9a3'
  const setPracticeConfig = useAppStore(s => s.setPracticeConfig)
  const storageError = useAppStore(s => s.storageError)
  const [historyError, setHistoryError] = useState('')
  const [scoreTimeline, setScoreTimeline] = useState<Timeline | null>(null)
  const [previous, setPrevious] = useState<{ stats: TuneStats; startedAt: number } | null>(null)
  const [comparisonMessage, setComparisonMessage] = useState('')
  const [syncLoading, setSyncLoading] = useState(false)
  const [syncError, setSyncError] = useState('')
  const compatibleRef = useRef<string | null>(null)
  const accompanimentForRef = useRef<string | null>(null)

  const [analysis, setAnalysis] = useState<Analysis>({ status: 'analyzing' })
  const [syncEnabled, setSyncEnabled] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  const syncEnabledRef = useRef(false)
  const ignoreNextPlayRef = useRef(false)
  const mountedRef = useRef(true)
  const syncOperationRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      syncOperationRef.current += 1
    }
  }, [])

  // 音高分析：解码录音 → 逐帧 YIN → 与目标时间轴对比（不支持解码的浏览器保留纯回放）
  useEffect(() => {
    if (!take) return
    let alive = true
    setAnalysis({ status: 'analyzing' })
    setScoreTimeline(null)
    setPrevious(null)
    setComparisonMessage('')
    setHistoryError('')
    compatibleRef.current = null
    const run = async () => {
      try {
        if (!song) {
          setAnalysis({ status: 'incompatible', message: '这首曲目不在当前曲库，仍可回放和下载原录音；音准分析、重练与伴奏对照不可用。' })
          return
        }
        const { xml, timeline } = await loadSong(song)
        if (!alive) return
        if (take.practice && (take.practice.songVersion !== songVersion(xml, timeline) || take.practice.scoringVersion !== SCORING_VERSION)) {
          setAnalysis({ status: 'incompatible', message: '曲谱、时间轴或评分版本已变更，仍可回放和下载原录音；本记录不重新评分、不提供比较或重练。' })
          return
        }
        compatibleRef.current = take.sessionId
        setScoreTimeline(timeline)
        let result: ScoreResult
        if (take.stats && take.pitchTrack) {
          result = scoreAgainst(take.pitchTrack, timelineInRange(timeline, take.startSec, take.stopSec))
        } else {
          await new Promise(r => setTimeout(r, 60))
          if (!alive) return
          const ab = take.audioBlob ? await take.audioBlob.arrayBuffer() : await (await fetch(take.audioUrl)).arrayBuffer()
          if (!alive) return
          const buffer = await audioEngine.decode(ab)
          if (!alive) return
          const track = await extractPitchTrackAsync(buffer, { offsetSec: take.startSec, shouldContinue: () => alive })
          if (!alive || track === null) return
          result = scoreAgainst(track, timelineInRange(timeline, take.startSec, take.stopSec))
          cacheTakeAnalysis(take.sessionId, result.annotatedTrack, result.stats)
          if (take.practice && take.audioBlob && !useAppStore.getState().storageError) {
            try { await updatePracticeAnalysis(take.sessionId, result.annotatedTrack, result.stats) }
            catch (error) { if (alive) setHistoryError(`分析结果未保存：${error instanceof Error ? error.message : String(error)}`) }
          }
        }
        if (!alive) return
        setAnalysis({ status: 'done', result })
        if (take.practice && take.audioBlob) {
          try {
            const records = await listPractices()
            if (!alive) return
            const current: StoredPractice = { ...take, schemaVersion: 1, audioBlob: take.audioBlob, practice: take.practice }
            const candidates = records.filter(r => r.sessionId !== take.sessionId && r.startedAt <= take.startedAt && r.stats)
            const prior = candidates.find(r => comparisonReason(current, r) === null)
            if (prior?.stats) setPrevious({ stats: prior.stats, startedAt: prior.startedAt })
            else setComparisonMessage(candidates.length ? comparisonReason(current, candidates[0]) ?? '暂无可比较记录。' : '还没有已分析的兼容记录，打开之前的练习记录分析后再来比较。')
          } catch (error) { if (alive) setHistoryError(`无法读取比较记录：${error instanceof Error ? error.message : String(error)}`) }
        }
      } catch (error) {
        if (alive) setAnalysis({ status: 'unsupported', message: error instanceof Error ? error.message : String(error) })
      }
    }
    void run()
    return () => { alive = false; compatibleRef.current = null }
    // Analysis cache updates must not restart extraction or interrupt playback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [takeSessionId, takeAudioUrl, cacheTakeAnalysis])

  // 对照播放：录音文件使用局部时间，伴奏使用 startSec + 录音局部时间。
  useEffect(() => {
    const el = audioRef.current
    syncEnabledRef.current = false
    setSyncEnabled(false)
    setSyncLoading(false)
    setSyncError('')
    accompanimentForRef.current = null
    let alive = true
    const onEnded = () => {
      syncOperationRef.current += 1
      audioEngine.pause()
      syncEnabledRef.current = false
      setSyncEnabled(false)
    }
    const alignPlayback = () => {
      if (!syncEnabledRef.current || takeStartSec === undefined || !el || el.paused) return
      const operation = ++syncOperationRef.current
      void (async () => {
        try {
          await audioEngine.resume()
        } catch {
          return
        }
        if (!alive || !syncEnabledRef.current || el.paused || operation !== syncOperationRef.current) return
        const started = await audioEngine.play(takeStartSec + el.currentTime)
        if (!started && alive && operation === syncOperationRef.current) {
          syncEnabledRef.current = false
          setSyncEnabled(false)
        }
      })()
    }
    const onPlay = () => {
      if (ignoreNextPlayRef.current) {
        ignoreNextPlayRef.current = false
        return
      }
      alignPlayback()
    }
    const onPause = () => {
      syncOperationRef.current += 1
      setSyncLoading(false)
      if (syncEnabledRef.current) audioEngine.pause()
    }
    const onSeeking = () => {
      syncOperationRef.current += 1
      if (syncEnabledRef.current && takeStartSec !== undefined && el) {
        audioEngine.pause()
        audioEngine.seek(takeStartSec + el.currentTime)
        alignPlayback()
      }
    }
    el?.addEventListener('ended', onEnded)
    el?.addEventListener('play', onPlay)
    el?.addEventListener('pause', onPause)
    el?.addEventListener('seeking', onSeeking)
    audioEngine.onEnd = onEnded
    return () => {
      alive = false
      syncOperationRef.current += 1
      el?.removeEventListener('ended', onEnded)
      el?.removeEventListener('play', onPlay)
      el?.removeEventListener('pause', onPause)
      el?.removeEventListener('seeking', onSeeking)
      audioEngine.onEnd = undefined
      audioEngine.pause()
    }
  }, [takeSessionId, takeAudioUrl, takeStartSec])

  // 对照播放截断：伴奏只播到停止时刻（录音 ended 通常同时刻先到，此处兜底
  // 录音时长偏差/静音尾场景；自然结束 stopSec≈buffer 末尾，行为与现状一致）
  useEffect(() => {
    if (!syncEnabled || !take) return
    const stopSec = take.stopSec
    let raf = 0
    const check = () => {
      if (audioEngine.playing && audioEngine.time >= stopSec) {
        audioRef.current?.pause()
        audioEngine.pause()
        syncEnabledRef.current = false
        setSyncEnabled(false)
        return
      }
      raf = requestAnimationFrame(check)
    }
    raf = requestAnimationFrame(check)
    return () => cancelAnimationFrame(raf)
  }, [syncEnabled, take])

  const toggleSyncPlay = useCallback(async () => {
    const el = audioRef.current
    if (!el || !take || !song || compatibleRef.current !== take.sessionId || syncLoading) return
    const operation = ++syncOperationRef.current
    if (syncEnabledRef.current) {
      syncEnabledRef.current = false
      el.pause()
      audioEngine.pause()
      setSyncEnabled(false)
    } else {
      try {
        await audioEngine.resume()
        if (!mountedRef.current || operation !== syncOperationRef.current) return
        // Restored records cannot inherit another song's retained engine buffer.
        if (take.practice && accompanimentForRef.current !== take.sessionId) {
          setSyncLoading(true)
          const { xml, timeline } = await loadSong(song)
          if (!mountedRef.current || operation !== syncOperationRef.current) return
          if (take.practice.songVersion !== songVersion(xml, timeline)) throw new Error('曲目版本已变更，无法对照播放。')
          const { buffer } = await loadAccompaniment(song, timeline)
          if (!mountedRef.current || operation !== syncOperationRef.current) return
          await audioEngine.load(buffer)
          if (!mountedRef.current || operation !== syncOperationRef.current) return
          accompanimentForRef.current = take.sessionId
          setSyncLoading(false)
        }
      } catch (error) {
        if (mountedRef.current && operation === syncOperationRef.current) { setSyncLoading(false); setSyncError(`伴奏无法载入：${error instanceof Error ? error.message : String(error)}`) }
        return
      }
      if (!mountedRef.current || operation !== syncOperationRef.current) return
      el.currentTime = 0
      const started = await audioEngine.play(take.startSec)
      if (!mountedRef.current || operation !== syncOperationRef.current || !started) return
      syncEnabledRef.current = true
      setSyncEnabled(true)
      ignoreNextPlayRef.current = true
      try {
        await el.play()
        if (!mountedRef.current || operation !== syncOperationRef.current) return
        ignoreNextPlayRef.current = false
      } catch {
        if (!mountedRef.current || operation !== syncOperationRef.current) return
        ignoreNextPlayRef.current = false
        syncEnabledRef.current = false
        setSyncEnabled(false)
        audioEngine.pause()
      }
    }
  }, [take, song, syncLoading])

  /** 下载录音按钮：32kHz 单声道 WAV 直采录音直接下载；旧版 MediaRecorder
   *  webm/mp4 take 解码重编码 WAV（webm 缺 duration 元数据，直接下载在部分
   *  播放器无声），解码失败回退原样下载 */
  const downloadTake = async () => {
    if (!take || downloading) return
    setDownloading(true)
    const stamp = new Date(take.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '')
    const saveAs = (href: string, ext: string) => {
      const a = document.createElement('a')
      a.href = href
      a.download = `syrinx-${take.songId}-${stamp}.${ext}`
      a.click()
    }
    try {
      if (take.audioBlob) { downloadPracticeBlob(take, take.audioBlob); return }
      if (take.mimeType === 'audio/wav') {
        // 直采录音已是 32kHz 单声道 WAV：直接下载，解码重编码反而放大体积
        saveAs(take.audioUrl, 'wav')
        return
      }
      try {
        const res = await fetch(take.audioUrl)
        const buffer = await audioEngine.decode(await res.arrayBuffer())
        const url = URL.createObjectURL(encodeWav(buffer))
        saveAs(url, 'wav')
        // 留出浏览器取走 blob 的时间再释放
        setTimeout(() => URL.revokeObjectURL(url), 30_000)
      } catch {
        const ext = take.mimeType.includes('mp4') ? 'mp4' : 'webm'
        saveAs(take.audioUrl, ext)
      }
    } finally {
      setDownloading(false)
    }
  }

  if (!session || session.status !== 'completed' || !take) {
    const noRecording = session?.status === 'no-recording'
    const failed = session?.status === 'failed'
    const saving = session?.status === 'saving'
    const title = noRecording
      ? '本次没有录音'
      : failed
        ? '录音保存失败'
        : saving
          ? '正在保存录音'
          : '还没有演奏记录'
    const message = session?.message ?? (saving
      ? '保存完成后即可查看回放与音准分析。'
      : '完成一次演奏后来这里查看回放与音准分析。')
    return (
      <main className="result empty">
        <div className="empty-card">
          <div className="empty-glyph">♪</div>
          <h2>{title}</h2>
          <p>{message}</p>
          <div className="empty-actions">
            <button className="btn-pill" onClick={() => go('history')}>练习记录</button>
            <button className="btn-pill" onClick={() => go('home')}>
              去曲库选曲
            </button>
          </div>
        </div>
      </main>
    )
  }

  const stats = analysis.status === 'done' ? analysis.result.stats : null
  // 图表时间域：演奏录音与目标时间轴取大（保险起见至少 1s）
  const chartDuration =
    analysis.status === 'done'
      ? Math.max(
          take.stopSec,
          1,
          ...analysis.result.notes.map((n) => n.note.time + n.note.duration),
        )
      : Math.max(take.stopSec, 1)

  return (
    <main className="result" style={{ '--song-accent': accent } as React.CSSProperties}>
      <header className="result-topbar">
        <button className="back-ghost" onClick={() => go('home')} aria-label="返回曲库">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path
              d="M10 3 5 8l5 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <div className="logo">
          <img src={assetUrl('/brand/syrinx-logo-white.jpg')} alt="" aria-hidden="true" />
          Syrinx
        </div>
      </header>

      <section className="result-hero">
        <div className="kicker">演奏回放 · REPLAY</div>
        <h1>{song?.title ?? take.songId}</h1>
        <div className="result-meta">
          {new Date(take.startedAt).toLocaleString('zh-CN')} · 录音时长 {fmt(take.durationSec)} ·{' '}
          采集位置 {fmt(take.startSec)}–{fmt(take.stopSec)}
        </div>
      </section>

      {(storageError || historyError) && <p className="result-warning" role="alert">{storageError || historyError}</p>}
      {take.practice && <p className="practice-summary">{take.practice.range ? `第 ${take.practice.range.startMeasure}–${take.practice.range.endMeasure} 小节` : '整曲'} · 第 {take.practice.round} / {take.practice.rounds} 轮</p>}
      <section className="result-grid">
        <div className="playback-card">
          <h3>录音回放</h3>
          <div className="pdeck-area">
            {/* 伴奏滑杆只在对照播放开启时出现（t_5957a725）：只回听录音不需要，
                且伴奏增益与演奏页共用，不该在回放页随手可动 */}
            <PlaybackDeck
              src={take.audioUrl}
              accent={accent}
              audioRef={audioRef}
              fallbackDurationSec={take.durationSec}
              showAccVol={syncEnabled}
            />
          </div>
          {syncError && <p role="alert" className="result-warning">{syncError}</p>}
          <div className="playback-actions">
            <button
              className="btn-pill sync"
              onClick={() => void toggleSyncPlay()}
              disabled={!song || compatibleRef.current !== take.sessionId || syncLoading}
              title="录音与伴奏从同一时刻起播，对照听辨"
            >
              {syncLoading ? '正在准备本曲伴奏…' : syncEnabled ? '❚❚ 停止对照' : '♫ 对照伴奏播放'}
            </button>
            <button
              className="btn-pill"
              onClick={() => void downloadTake()}
              disabled={downloading}
              title="下载本段录音（32kHz 单声道 WAV）"
            >
              {downloading ? '下载中…' : '⤓ 下载录音'}
            </button>
          </div>
        </div>

        <div className="stats-card">
          <h3>音准统计</h3>
          {analysis.status === 'incompatible' && <div className="stats-state warn">{analysis.message}</div>}
          {analysis.status === 'analyzing' && <div className="stats-state">音高分析中…</div>}
          {analysis.status === 'unsupported' && (
            <div className="stats-state warn">
              该浏览器暂不支持录音音高分析（{analysis.message.slice(0, 80)}），回放不受影响。
            </div>
          )}
          {analysis.status === 'error' && (
            <div className="stats-state warn">分析出错：{analysis.message.slice(0, 120)}</div>
          )}
          {analysis.status === 'done' && stats && (
            <>
              <div className="stats-grid">
              <div className="stat">
                <b style={{ color: stats.inTuneRatio >= 0.7 ? accent : 'var(--rec)' }}>
                  {Math.round(stats.inTuneRatio * 100)}%
                </b>
                <span>已测音符音准率（±50 音分）</span>
              </div>
              <div className="stat">
                <b>{stats.avgAbsCents.toFixed(0)}</b>
                <span>平均偏差（音分）</span>
              </div>
              <div className="stat">
                <b>
                  {Math.round(stats.coverageRatio * 100)}%
                  <i className="miss"> / {stats.missedNoteCount ? `漏 ${stats.missedNoteCount}` : '无漏音'}</i>
                </b>
                <span>音符覆盖率（已测 {stats.noteCount} / {stats.totalNoteCount}）</span>
              </div>
              <div className="stat">
                <b>{fmt(take.durationSec)}</b>
                <span>实际录音时长</span>
              </div>
            </div>
            </>
          )}
        </div>
      </section>

      <section className="chart-section" aria-label="音高对比图">
        {analysis.status === 'done' ? (
          <>
            <PitchChart
              notes={analysis.result.notes}
              track={analysis.result.annotatedTrack}
              durationSec={chartDuration}
              accent={accent}
            />
            <div className="chart-legend">
              <span>
                <i className="sw hit" /> 命中（±50 音分内）
              </span>
              <span>
                <i className="sw off" /> 偏音（超 ±50 音分）
              </span>
              <span>
                <i className="sw miss" /> 漏音
              </span>
            </div>
          </>
        ) : (
          <div className="chart-placeholder">
            {analysis.status === 'analyzing' ? '正在绘制音高轨迹…' : '音高对比图不可用'}
          </div>
        )}
      </section>

      {analysis.status === 'done' && scoreTimeline && <section className="practice-feedback" aria-label="待练小节">
        <h3>下次重点练习</h3><p>按本次采集范围内的完整音符统计。未检测到音高也可能与录音质量有关。</p>
        <div className="weak-bars">{weakMeasures(analysis.result, scoreTimeline).map(bar => <div key={bar.range.startMeasure}><b>第 {bar.range.startMeasure} 小节</b><span>漏 {bar.missed} / {bar.total} · 偏差 {bar.avgAbsCents === null ? '暂无实测' : `${Math.round(bar.avgAbsCents)} 音分`}</span><button className="btn-pill" onClick={() => { if (!song) return; setPracticeConfig({ songId: song.id, range: bar.range, rounds: 3 }); go('perform', song.id) }}>重练此小节 · 3 轮</button></div>)}</div>
        {previous ? <p className="practice-delta">与 {new Date(previous.startedAt).toLocaleString('zh-CN')} 的兼容练习相比：音准率 {((analysis.result.stats.inTuneRatio - previous.stats.inTuneRatio) * 100).toFixed(0)} 个百分点，漏音 {analysis.result.stats.missedNoteCount - previous.stats.missedNoteCount} 个（负数表示减少）。</p> : comparisonMessage && <p>{comparisonMessage}</p>}
      </section>}
      <footer className="result-actions">
        <button className="btn-pill primary" style={{ background: accent, color: '#06130d', borderColor: 'transparent' }} disabled={!song || analysis.status === 'incompatible'} onClick={() => { if (!song) return; setPracticeConfig(null); go('perform', song.id) }}>
          ↺ 重新演奏
        </button>
        <button className="btn-pill" onClick={() => go('history')}>练习记录</button>
        <button className="btn-pill" onClick={() => go('home')}>
          返回曲库
        </button>
      </footer>
    </main>
  )
}
