import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { loadAccompaniment } from '../audio/accompaniment'
import { planMix, renderMix } from '../audio/mix'
import { encodeWav } from '../audio/wav'
import PlaybackDeck from '../components/PlaybackDeck'
import PitchChart from '../components/PitchChart'
import { extractPitchTrackAsync, scoreAgainst, timelineInRange, type ScoreResult } from '../pitch/compare'
import { getSong, loadSong, SONGS } from '../songs'
import { assetUrl } from '../lib/assetUrl'
import { pickSongText, useLangStore, useT } from '../i18n'
import { useAppStore } from '../store'
import type { PerformanceSegment, Timeline } from '../types'
import './ResultPage.css'

type Analysis =
  | { status: 'analyzing'; progress?: number }
  | { status: 'done'; result: ScoreResult }
  | { status: 'unsupported'; message: string }
  | { status: 'error'; message: string }

const fmt = (sec: number): string =>
  `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

function segmentRangeLabel(
  timeline: Timeline,
  segment: PerformanceSegment,
  t: (key: 'result.measure' | 'result.measureRange', params?: Record<string, string | number>) => string,
): string {
  const anchors = timeline.measureTimes.filter((item) => !item.end)
  const start = [...anchors].reverse().find((item) => item.time <= segment.startSec)
  const endTime = Math.max(segment.startSec, segment.stopSec - 0.000_001)
  const end = [...anchors].reverse().find((item) => item.time <= endTime)
  if (!start || !end) return `${fmt(segment.startSec)}–${fmt(segment.stopSec)}`
  return start.measure === end.measure
    ? t('result.measure', { m: start.measure })
    : t('result.measureRange', { a: start.measure, b: end.measure })
}

export default function ResultPage() {
  const t = useT()
  const lang = useLangStore((s) => s.lang)
  const session = useAppStore((s) => s.performanceSession)
  const segments = useMemo<PerformanceSegment[]>(() => {
    if (session?.status !== 'completed') return []
    if (session.segments?.length) return session.segments
    return session.take ? [{ ...session.take, id: `legacy-${session.take.sessionId}` }] : []
  }, [session])
  const [selectedSegmentId, setSelectedSegmentId] = useState('')
  const take = segments.find((segment) => segment.id === selectedSegmentId) ?? segments.at(-1) ?? null
  const takeSessionId = take ? `${take.sessionId}:${take.id}` : undefined
  const takeAudioUrl = take?.audioUrl
  const takeStartSec = take?.startSec
  const takeRate = take?.playbackRate && Number.isFinite(take.playbackRate) && take.playbackRate >= 0.5 && take.playbackRate <= 1.5 ? take.playbackRate : 1
  const currentSongId = useAppStore((s) => s.currentSongId)
  const songId = session?.songId ?? currentSongId
  const go = useAppStore((s) => s.go)
  const cacheTakeAnalysis = useAppStore((s) => s.cacheTakeAnalysis)
  const cacheSegmentAnalysis = useAppStore((s) => s.cacheSegmentAnalysis)
  const song = getSong(songId) ?? SONGS[0]

  const [storedAnalysis, setStoredAnalysis] = useState<{ key?: string; value: Analysis }>({ value: { status: 'analyzing' } })
  const analysis = useMemo<Analysis>(() => storedAnalysis.key === takeSessionId ? storedAnalysis.value : { status: 'analyzing' }, [storedAnalysis, takeSessionId])
  const [syncEnabled, setSyncEnabled] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [mixing, setMixing] = useState(false)
  const [accMix, setAccMix] = useState<{ status: 'loading' | 'ready' | 'unavailable'; buffer: AudioBuffer | null }>({ status: 'loading', buffer: null })
  const [rangeTimeline, setRangeTimeline] = useState<{ songId: string; timeline: Timeline } | null>(null)
  const rangeFor = (segment: PerformanceSegment) => rangeTimeline?.songId === segment.songId ? segmentRangeLabel(rangeTimeline.timeline, segment, t) : `${fmt(segment.startSec)}–${fmt(segment.stopSec)}`
  const rangeLabel = take ? rangeFor(take) : ''
  const audioRef = useRef<HTMLAudioElement>(null)
  const syncEnabledRef = useRef(false)
  const ignoreNextPlayRef = useRef(false)
  const syncRewindingRef = useRef(false)
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
    const setAnalysis = (value: Analysis) => setStoredAnalysis({ key: takeSessionId, value })
    setAnalysis({ status: 'analyzing' })
    // 只分析完整落在实际采集起止位置内的目标音；延迟开麦和中途关录前后的
    // 音符不进入漏音分母。
    const scoreTimeline = (timeline: Awaited<ReturnType<typeof loadSong>>['timeline']) =>
      timelineInRange(timeline, take.startSec, take.stopSec)
    let alive = true
    const aborter = new AbortController()
    if (take.stats && take.pitchTrack) {
      // 已有缓存结果：仅重建图表数据（属性收窄不进闭包，先取局部量）
      const cachedTrack = take.pitchTrack
      void (async () => {
        const { timeline } = await loadSong(song)
        if (!alive) return
        setRangeTimeline({ songId: take.songId, timeline })
        setAnalysis({ status: 'done', result: scoreAgainst(cachedTrack, scoreTimeline(timeline)) })
      })().catch((error: unknown) => { if (alive) setAnalysis({ status: 'error', message: error instanceof Error ? error.message : String(error) }) })
      return () => {
        alive = false
      }
    }
    ;(async () => {
      try {
        // 先让「分析中」状态渲染出来，再进入重计算
        await new Promise((r) => setTimeout(r, 0))
        const { timeline } = await loadSong(song)
        if (!alive) return
        setRangeTimeline({ songId: take.songId, timeline })
        const res = await fetch(take.audioUrl)
        const ab = await res.arrayBuffer()
        const buffer = await audioEngine.decode(ab)
        if (!alive) return
        // 录音起点对齐伴奏时间轴：中途开录/回开头重录时，轨迹时间整体平移 startSec
        // 分片异步提取（每 ~24ms 让出主线程）：分析期间按钮/滚动保持可响应，
        // 用户点「重新演奏/返回曲库」离开本页时 alive 置 false，计算立即中止丢弃
        const track = await extractPitchTrackAsync(buffer, {
          shouldContinue: () => alive,
          signal: aborter.signal,
          onProgress: progress => { if (alive) setAnalysis({ status: 'analyzing', progress }) },
        })
        if (!alive || track === null) return
        const songTrack = track.map(point => ({ ...point, time: take.startSec + point.time * takeRate }))
        const result = scoreAgainst(songTrack, scoreTimeline(timeline))
        setAnalysis({ status: 'done', result })
        if (session?.segments?.some((segment) => segment.id === take.id)) {
          cacheSegmentAnalysis(take.sessionId, take.id, result.annotatedTrack, result.stats)
        } else {
          cacheTakeAnalysis(take.sessionId, result.annotatedTrack, result.stats)
        }
      } catch (e) {
        if (!alive) return
        setAnalysis({
          status: 'unsupported',
          message: e instanceof Error ? e.message : String(e),
        })
      }
    })()
    return () => {
      alive = false
      aborter.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take, takeSessionId, takeRate, song, cacheSegmentAnalysis, cacheTakeAnalysis])

  // 混音伴奏预载：下载混音需要整段伴奏 buffer（与演奏页共用 loader 缓存）。
  // 加载失败（外部伴奏拉取失败且曲谱不可合成/曲谱本身不可用）时禁用混音按钮。
  useEffect(() => {
    if (!session || session.status !== 'completed') return
    let alive = true
    setAccMix({ status: 'loading', buffer: null })
    ;(async () => {
      try {
        const { timeline } = await loadSong(song)
        const { buffer } = await loadAccompaniment(song, timeline)
        if (alive) setAccMix({ status: 'ready', buffer })
      } catch {
        if (alive) setAccMix({ status: 'unavailable', buffer: null })
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song, session?.status])

  const selectSegment = useCallback((id: string) => {
    if (id === take?.id) return
    syncOperationRef.current += 1
    ignoreNextPlayRef.current = false
    syncRewindingRef.current = false
    syncEnabledRef.current = false
    setSyncEnabled(false)
    audioRef.current?.pause()
    audioEngine.pause()
    setSelectedSegmentId(id)
  }, [take?.id])

  // 对照播放：录音文件使用局部时间，伴奏使用 startSec + 录音局部时间。
  useEffect(() => {
    const el = audioRef.current
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
        const started = await audioEngine.play(takeStartSec + el.currentTime * takeRate)
        if (!alive || !syncEnabledRef.current || el.paused || operation !== syncOperationRef.current) return
        if (started) {
          audioEngine.seek(takeStartSec + el.currentTime * takeRate)
        } else {
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
      syncRewindingRef.current = false
      audioEngine.pause()
    }
    const onSeeking = () => {
      // Rewinding our own recording before an awaited native media play is
      // part of the current operation, not a new user seek that cancels it.
      if (syncRewindingRef.current && el?.currentTime === 0) return
      syncOperationRef.current += 1
      syncRewindingRef.current = false
      audioEngine.pause()
      if (syncEnabledRef.current && takeStartSec !== undefined && el) {
        audioEngine.seek(takeStartSec + el.currentTime * takeRate)
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
      syncRewindingRef.current = false
      el?.removeEventListener('ended', onEnded)
      el?.removeEventListener('play', onPlay)
      el?.removeEventListener('pause', onPause)
      el?.removeEventListener('seeking', onSeeking)
      audioEngine.onEnd = undefined
      audioEngine.pause()
    }
  }, [takeSessionId, takeAudioUrl, takeStartSec, takeRate])

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
    if (!el || audioEngine.duration === 0 || !take) return
    const operation = ++syncOperationRef.current
    if (syncEnabledRef.current) {
      syncEnabledRef.current = false
      el.pause()
      audioEngine.pause()
      setSyncEnabled(false)
    } else {
      try {
        await audioEngine.resume()
      } catch {
        return
      }
      if (!mountedRef.current || operation !== syncOperationRef.current) return
      audioEngine.pause()
      const prepared = await audioEngine.setRate(takeRate)
      if (!mountedRef.current || operation !== syncOperationRef.current || !prepared) return
      syncRewindingRef.current = true
      el.currentTime = 0
      const started = await audioEngine.play(take.startSec)
      if (!mountedRef.current || operation !== syncOperationRef.current) return
      syncRewindingRef.current = false
      if (!started) return
      syncEnabledRef.current = true
      setSyncEnabled(true)
      ignoreNextPlayRef.current = true
      try {
        await el.play()
        if (!mountedRef.current || operation !== syncOperationRef.current) return
        ignoreNextPlayRef.current = false
        // Native media can take different amounts of time to start. Once both
        // are running, align accompaniment to the recording's actual clock.
        audioEngine.seek(take.startSec + el.currentTime * takeRate)
      } catch {
        if (!mountedRef.current || operation !== syncOperationRef.current) return
        ignoreNextPlayRef.current = false
        syncEnabledRef.current = false
        setSyncEnabled(false)
        audioEngine.pause()
      }
    }
  }, [take, takeRate])

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
      a.download = `syrinx-${song.id}-${stamp}-part${segments.findIndex((segment) => segment.id === take.id) + 1}.${ext}`
      a.click()
    }
    try {
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

  /** 下载混音按钮：OfflineAudioContext 离线渲染「录音+伴奏」，时长 = 录音实长，
   *  两轨各 1.0 定增益；takeRate≠1 时伴奏窗口经 WSOLA 保调拉伸对齐
   *  （preservesPitch 同款铁律，映射关系见 audio/mix.ts planMix） */
  const downloadMix = async () => {
    if (!take || mixing || accMix.status !== 'ready' || !accMix.buffer) return
    setMixing(true)
    const stamp = new Date(take.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '')
    try {
      const res = await fetch(take.audioUrl)
      const recBuffer = await audioEngine.decode(await res.arrayBuffer())
      const plan = planMix(take, recBuffer.duration, accMix.buffer.duration)
      if (!plan) return
      const rendered = await renderMix(plan, recBuffer, accMix.buffer)
      const url = URL.createObjectURL(encodeWav(rendered))
      const a = document.createElement('a')
      a.href = url
      a.download = `syrinx-${song.id}-${stamp}-part${segments.findIndex((segment) => segment.id === take.id) + 1}-mix.wav`
      a.click()
      // 留出浏览器取走 blob 的时间再释放
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (e: unknown) {
      console.warn(`[result] 混音下载失败：${e instanceof Error ? e.message : e}`)
    } finally {
      setMixing(false)
    }
  }

  const chartData = useMemo(() => {
    if (!take || analysis.status !== 'done') return null
    return {
      notes: analysis.result.notes.map(item => ({ ...item, note: { ...item.note, time: (item.note.time - take.startSec) / takeRate, duration: item.note.duration / takeRate } })),
      track: analysis.result.annotatedTrack.map(point => ({ ...point, time: (point.time - take.startSec) / takeRate })),
      durationSec: Math.max((take.stopSec - take.startSec) / takeRate, 1),
    }
  }, [take, takeRate, analysis])

  if (!session || session.status !== 'completed' || !take) {
    const noRecording = session?.status === 'no-recording'
    const failed = session?.status === 'failed'
    const saving = session?.status === 'saving'
    const title = noRecording
      ? t('result.emptyNoRecording')
      : failed
        ? t('result.emptyFailed')
        : saving
          ? t('result.emptySaving')
          : t('result.emptyNoSession')
    const message = session?.message ?? (saving
      ? t('result.emptySavingHint')
      : t('result.emptyHint'))
    return (
      <main className="result empty">
        <div className="empty-card">
          <div className="empty-glyph">♪</div>
          <h2>{title}</h2>
          <p>{message}</p>
          <div className="empty-actions">
            <button className="btn-pill" onClick={() => go('home')}>
              {t('result.goLibrary')}
            </button>
          </div>
        </div>
      </main>
    )
  }

  const stats = analysis.status === 'done' ? analysis.result.stats : null
  // 每段从局部 0 秒开始绘图，跳过的曲谱不占据图表空间。

  return (
    <main className="result" style={{ '--song-accent': song.accent } as React.CSSProperties}>
      <header className="result-topbar">
        <button className="back-ghost" onClick={() => go('home')} aria-label={t('common.backToLibrary')}>
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
        <div className="kicker">{t('result.replayKicker')}</div>
        <h1>{pickSongText(song, 'title')}</h1>
        <div className="result-meta">
          {new Date(take.startedAt).toLocaleString(lang === 'en' ? 'en-US' : 'zh-CN')} · {t('result.recDuration', { time: fmt(take.durationSec) })} ·{' '}
          {t('result.captureRange', { range: `${fmt(take.startSec)}–${fmt(take.stopSec)}` })} · {rangeLabel}
          {takeRate !== 1 && ` · ${t('result.tempoPct', { pct: Math.round(takeRate * 100) })}`}
        </div>
        {session.message && <p className="result-save-warning" role="alert">{session.message}</p>}
        {segments.length > 1 && <label className="segment-selector">{t('result.segments')}
          <select aria-label={t('result.segmentSelect')} value={take.id} onChange={(event) => selectSegment(event.target.value)}>
            {segments.map((segment, index) => <option key={segment.id} value={segment.id}>{t('result.segmentOption', { n: index + 1, range: rangeFor(segment), dur: fmt(segment.durationSec) })}</option>)}
          </select><span>{t('result.segmentsTotal', { n: segments.length })}</span>
        </label>}
      </section>

      <section className="result-grid">
        <div className="playback-card">
          <h3>{t('result.playbackCard')}</h3>
          <div className="pdeck-area">
            {/* 伴奏滑杆只在对照播放开启时出现（t_5957a725）：只回听录音不需要，
                且伴奏增益与演奏页共用，不该在回放页随手可动 */}
            <PlaybackDeck
              key={takeSessionId}
              src={take.audioUrl}
              accent={song.accent}
              audioRef={audioRef}
              fallbackDurationSec={take.durationSec}
              showAccVol={syncEnabled}
            />
          </div>
          <div className="playback-actions">
            <button
              className="btn-pill sync"
              onClick={() => void toggleSyncPlay()}
              disabled={audioEngine.duration === 0}
              title={t('result.syncTitle')}
            >
              {syncEnabled ? t('result.syncStop') : t('result.syncPlay')}
            </button>
            <button
              className="btn-pill"
              onClick={() => void downloadTake()}
              disabled={downloading}
              title={t('result.downloadTitle')}
            >
              {downloading ? t('result.downloading') : t('result.downloadRec')}
            </button>
            <button
              className="btn-pill"
              onClick={() => void downloadMix()}
              disabled={accMix.status !== 'ready' || mixing}
              title={accMix.status === 'unavailable' ? t('result.mixUnavailableTitle') : t('result.mixTitle')}
            >
              {mixing ? t('result.mixing') : t('result.downloadMix')}
            </button>
          </div>
        </div>

        <div className="stats-card">
          <h3>{t('result.statsCard')}</h3>
          {analysis.status === 'analyzing' && <div className="stats-state" role="status">
            <span>{analysis.progress === undefined ? t('result.readingRec') : t('result.analyzing', { pct: Math.round(analysis.progress * 100) })}</span>
            <progress className="analysis-progress" aria-label={t('result.analysisProgress')} max={1} value={analysis.progress} />
            <small>{t('result.analysisBg')}</small>
          </div>}
          {analysis.status === 'unsupported' && (
            <div className="stats-state warn">
              {t('result.unsupported', { message: analysis.message.slice(0, 80) })}
            </div>
          )}
          {analysis.status === 'error' && (
            <div className="stats-state warn">{t('result.analysisError', { message: analysis.message.slice(0, 120) })}</div>
          )}
          {analysis.status === 'done' && stats && (
            <>
              <div className="stats-grid">
              <div className="stat">
                <b style={{ color: stats.inTuneRatio >= 0.7 ? song.accent : 'var(--rec)' }}>
                  {Math.round(stats.inTuneRatio * 100)}%
                </b>
                <span>{t('result.statInTune')}</span>
              </div>
              <div className="stat">
                <b>{stats.avgAbsCents.toFixed(0)}</b>
                <span>{t('result.statAvgDev')}</span>
              </div>
              <div className="stat">
                <b>
                  {Math.round(stats.coverageRatio * 100)}%
                  <i className="miss"> / {stats.missedNoteCount ? t('result.statMiss', { n: stats.missedNoteCount }) : t('result.statNoMiss')}</i>
                </b>
                <span>{t('result.statCoverage', { measured: stats.noteCount, total: stats.totalNoteCount })}</span>
              </div>
              <div className="stat">
                <b>{fmt(take.durationSec)}</b>
                <span>{t('result.statDuration')}</span>
              </div>
            </div>
            </>
          )}
        </div>
      </section>

      <section className="chart-section" aria-label={t('result.chartAria')}>
        {analysis.status === 'done' && chartData ? (
          <>
            <PitchChart
              notes={chartData.notes}
              track={chartData.track}
              durationSec={chartData.durationSec}
              accent={song.accent}
              noDataText={t('pitchChart.noData')}
            />
            <div className="chart-legend">
              <span>
                <i className="sw hit" /> {t('result.legendHit')}
              </span>
              <span>
                <i className="sw off" /> {t('result.legendOff')}
              </span>
              <span>
                <i className="sw miss" /> {t('result.legendMiss')}
              </span>
            </div>
          </>
        ) : (
          <div className="chart-placeholder">
            {analysis.status === 'analyzing' ? t('result.chartPending') : t('result.chartUnavailable')}
          </div>
        )}
      </section>

      <footer className="result-actions">
        <button className="btn-pill primary" style={{ background: song.accent, color: '#06130d', borderColor: 'transparent' }} onClick={() => go('perform', song.id)}>
          {t('result.replay')}
        </button>
        <button className="btn-pill" onClick={() => go('home')}>
          {t('common.backToLibrary')}
        </button>
      </footer>
    </main>
  )
}
