import { useCallback, useEffect, useRef, useState } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import { encodeWav } from '../audio/wav'
import PlaybackDeck from '../components/PlaybackDeck'
import PitchChart from '../components/PitchChart'
import { extractPitchTrackAsync, scoreAgainst, timelineInRange, type ScoreResult } from '../pitch/compare'
import { getSong, loadSong, SONGS } from '../songs'
import { assetUrl } from '../lib/assetUrl'
import { useAppStore } from '../store'
import './ResultPage.css'

type Analysis =
  | { status: 'analyzing' }
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
  const song = getSong(songId) ?? SONGS[0]

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
    // 只分析完整落在实际采集起止位置内的目标音；延迟开麦和中途关录前后的
    // 音符不进入漏音分母。
    const scoreTimeline = (timeline: Awaited<ReturnType<typeof loadSong>>['timeline']) =>
      timelineInRange(timeline, take.startSec, take.stopSec)
    let alive = true
    if (take.stats && take.pitchTrack) {
      // 已有缓存结果：仅重建图表数据（属性收窄不进闭包，先取局部量）
      const cachedTrack = take.pitchTrack
      void (async () => {
        const { timeline } = await loadSong(song)
        if (!alive) return
        setAnalysis({ status: 'done', result: scoreAgainst(cachedTrack, scoreTimeline(timeline)) })
      })()
      return () => {
        alive = false
      }
    }
    ;(async () => {
      try {
        // 先让「分析中」状态渲染出来，再进入重计算
        await new Promise((r) => setTimeout(r, 60))
        const { timeline } = await loadSong(song)
        const res = await fetch(take.audioUrl)
        const ab = await res.arrayBuffer()
        const buffer = await audioEngine.decode(ab)
        if (!alive) return
        // 录音起点对齐伴奏时间轴：中途开录/回开头重录时，轨迹时间整体平移 startSec
        // 分片异步提取（每 ~24ms 让出主线程）：分析期间按钮/滚动保持可响应，
        // 用户点「重新演奏/返回曲库」离开本页时 alive 置 false，计算立即中止丢弃
        const track = await extractPitchTrackAsync(buffer, {
          offsetSec: take.startSec,
          shouldContinue: () => alive,
        })
        if (!alive || track === null) return
        const result = scoreAgainst(track, scoreTimeline(timeline))
        setAnalysis({ status: 'done', result })
        cacheTakeAnalysis(take.sessionId, result.annotatedTrack, result.stats)
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
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take, cacheTakeAnalysis])

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
  }, [take])

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
      a.download = `syrinx-${song.id}-${stamp}.${ext}`
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
    <main className="result" style={{ '--song-accent': song.accent } as React.CSSProperties}>
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
        <h1>{song.title}</h1>
        <div className="result-meta">
          {new Date(take.startedAt).toLocaleString('zh-CN')} · 录音时长 {fmt(take.durationSec)} ·{' '}
          采集位置 {fmt(take.startSec)}–{fmt(take.stopSec)}
        </div>
      </section>

      <section className="result-grid">
        <div className="playback-card">
          <h3>录音回放</h3>
          <div className="pdeck-area">
            {/* 伴奏滑杆只在对照播放开启时出现（t_5957a725）：只回听录音不需要，
                且伴奏增益与演奏页共用，不该在回放页随手可动 */}
            <PlaybackDeck
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
              title="录音与伴奏从同一时刻起播，对照听辨"
            >
              {syncEnabled ? '❚❚ 停止对照' : '♫ 对照伴奏播放'}
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
                <b style={{ color: stats.inTuneRatio >= 0.7 ? song.accent : 'var(--rec)' }}>
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
              accent={song.accent}
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

      <footer className="result-actions">
        <button className="btn-pill primary" style={{ background: song.accent, color: '#06130d', borderColor: 'transparent' }} onClick={() => go('perform', song.id)}>
          ↺ 重新演奏
        </button>
        <button className="btn-pill" onClick={() => go('home')}>
          返回曲库
        </button>
      </footer>
    </main>
  )
}
