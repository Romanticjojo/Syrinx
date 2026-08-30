import { useCallback, useEffect, useRef, useState } from 'react'
import { audioEngine } from '../audio/AudioEngine'
import PitchChart from '../components/PitchChart'
import { extractPitchTrack, scoreAgainst, type ScoreResult } from '../pitch/compare'
import { getSong, loadSong, SONGS } from '../songs'
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
  const take = useAppStore((s) => s.lastTake)
  const songId = useAppStore((s) => s.currentSongId)
  const go = useAppStore((s) => s.go)
  const setTake = useAppStore((s) => s.setTake)
  const song = getSong(songId) ?? SONGS[0]

  const [analysis, setAnalysis] = useState<Analysis>({ status: 'analyzing' })
  const [syncPlaying, setSyncPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)

  // 音高分析：解码录音 → 逐帧 YIN → 与目标时间轴对比（不支持解码的浏览器保留纯回放）
  useEffect(() => {
    if (!take) return
    let alive = true
    if (take.stats && take.pitchTrack) {
      // 已有缓存结果：仅重建图表数据（属性收窄不进闭包，先取局部量）
      const cachedTrack = take.pitchTrack
      void (async () => {
        const { timeline } = await loadSong(song)
        if (!alive) return
        setAnalysis({ status: 'done', result: scoreAgainst(cachedTrack, timeline) })
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
        const track = extractPitchTrack(buffer, { offsetSec: take.startSec })
        const result = scoreAgainst(track, timeline)
        setAnalysis({ status: 'done', result })
        setTake({ ...take, pitchTrack: result.annotatedTrack, stats: result.stats })
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
  }, [take])

  // 对照播放：录音与伴奏共享时间轴，同步起停
  useEffect(() => {
    const el = audioRef.current
    const onEnded = () => {
      audioEngine.pause()
      setSyncPlaying(false)
    }
    el?.addEventListener('ended', onEnded)
    audioEngine.onEnd = onEnded
    return () => {
      el?.removeEventListener('ended', onEnded)
      audioEngine.onEnd = undefined
      audioEngine.pause()
    }
  }, [])

  const toggleSyncPlay = useCallback(async () => {
    const el = audioRef.current
    if (!el || audioEngine.duration === 0 || !take) return
    await audioEngine.resume()
    if (syncPlaying) {
      el.pause()
      audioEngine.pause()
      setSyncPlaying(false)
    } else {
      // 录音与伴奏按起点对齐：起奏即录 startSec=0，回开头/中途重录则从 startSec 起播伴奏
      const startSec = take.startSec
      el.currentTime = startSec
      void el.play()
      audioEngine.play(startSec)
      setSyncPlaying(true)
    }
  }, [syncPlaying, take])

  /** 双击图表下载录音（webm/mp4 由 mime 决定扩展名） */
  const downloadTake = () => {
    if (!take) return
    const ext = take.mimeType.includes('mp4') ? 'mp4' : 'webm'
    const a = document.createElement('a')
    a.href = take.audioUrl
    a.download = `syrinx-${song.id}-${new Date(take.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '')}.${ext}`
    a.click()
  }

  if (!take) {
    return (
      <main className="result empty">
        <div className="empty-card">
          <div className="empty-glyph">♪</div>
          <h2>还没有演奏记录</h2>
          <p>完成一次演奏后来这里查看回放与音准分析。</p>
          <div className="empty-actions">
            <button className="btn-pill" onClick={() => go('home')}>
              去曲库选曲
            </button>
          </div>
        </div>
      </main>
    )
  }

  const stats = take.stats
  const missCount =
    analysis.status === 'done' ? analysis.result.notes.length - analysis.result.stats.noteCount : null
  // 图表时间域：演奏录音与目标时间轴取大（保险起见至少 1s）
  const chartDuration =
    analysis.status === 'done'
      ? Math.max(
          take.durationSec,
          1,
          ...analysis.result.notes.map((n) => n.note.time + n.note.duration),
        )
      : Math.max(take.durationSec, 1)

  return (
    <main className="result" style={{ '--song-accent': song.accent } as React.CSSProperties}>
      <header className="result-topbar">
        <button className="back-pill" onClick={() => go('home')} aria-label="返回曲库">
          ‹
        </button>
        <div className="logo">
          Syrinx<i style={{ fontStyle: 'normal', color: song.accent }}>·</i>长笛流光
        </div>
      </header>

      <section className="result-hero">
        <div className="kicker">演奏回放 · TAKE</div>
        <h1>{song.title}</h1>
        <div className="result-meta">
          {new Date(take.startedAt).toLocaleString('zh-CN')} · 演奏时长 {fmt(take.durationSec)}
        </div>
      </section>

      <section className="result-grid">
        <div className="playback-card">
          <h3>录音回放</h3>
          <audio ref={audioRef} src={take.audioUrl} controls preload="metadata" />
          <div className="playback-actions">
            <button
              className="btn-pill sync"
              onClick={() => void toggleSyncPlay()}
              disabled={audioEngine.duration === 0}
              title="录音与伴奏从同一时刻起播，对照听辨"
            >
              {syncPlaying ? '❚❚ 停止对照' : '♫ 对照伴奏播放'}
            </button>
            <span className="hint">双击下方图表可下载录音文件</span>
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
            <div className="stats-grid">
              <div className="stat">
                <b style={{ color: stats.inTuneRatio >= 0.7 ? song.accent : 'var(--rec)' }}>
                  {Math.round(stats.inTuneRatio * 100)}%
                </b>
                <span>音准率（±50 音分）</span>
              </div>
              <div className="stat">
                <b>{stats.avgAbsCents.toFixed(0)}</b>
                <span>平均偏差（音分）</span>
              </div>
              <div className="stat">
                <b>
                  {stats.noteCount}
                  <i className="miss"> / {missCount ? `漏 ${missCount}` : '全中'}</i>
                </b>
                <span>评估音符数</span>
              </div>
              <div className="stat">
                <b>{fmt(take.durationSec)}</b>
                <span>演奏时长</span>
              </div>
            </div>
          )}
        </div>
      </section>

      <section
        className="chart-section"
        onDoubleClick={downloadTake}
        title="双击下载录音"
        aria-label="音高对比图"
      >
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
                <i className="sw in" /> 实测音高 · 准（±50 音分内）
              </span>
              <span>
                <i className="sw off" /> 偏音（超 ±50 音分）
              </span>
              <span>
                <i className="sw note" /> 目标音符
              </span>
              <span>
                <i className="sw miss" /> 漏音（无实测）
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
