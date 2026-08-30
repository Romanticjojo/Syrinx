import { useEffect, useState } from 'react'
import FluteView from '../components/FluteView'
import ScoreSheet from '../components/ScoreSheet'
import { DIFFICULTY_LABEL, getSong, loadSong, SONGS } from '../songs'
import { useAppStore } from '../store'
import type { Timeline } from '../types'
import './PreviewPage.css'

export default function PreviewPage() {
  const songId = useAppStore((s) => s.currentSongId)
  const go = useAppStore((s) => s.go)
  const toggleFavorite = useAppStore((s) => s.toggleFavorite)
  const favorites = useAppStore((s) => s.favorites)
  const song = getSong(songId) ?? SONGS[0]
  const fav = favorites.includes(song.id)
  const [xml, setXml] = useState<string | null>(null)
  const [timeline, setTimeline] = useState<Timeline | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // 切曲时重置加载状态（渲染期间调整状态，避免 effect 内 setState 级联渲染）
  const [lastSongId, setLastSongId] = useState(song.id)
  if (lastSongId !== song.id) {
    setLastSongId(song.id)
    setXml(null)
    setTimeline(null)
    setLoadError(null)
  }

  // 加载曲谱与时间轴（预览用静态渲染）
  useEffect(() => {
    let alive = true
    loadSong(song)
      .then(({ xml: x, timeline: t }) => {
        if (!alive) return
        setXml(x)
        setTimeline(t)
      })
      .catch((e: unknown) => {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      alive = false
    }
  }, [song])

  const cover = {
    background: `radial-gradient(70% 55% at 30% 28%, rgba(255,255,255,.13), transparent 60%),
      radial-gradient(90% 80% at 75% 85%, ${song.accent}73, transparent 65%),
      linear-gradient(150deg, ${song.accent}2e, #0c1210 70%)`,
  }
  const rows: [string, string, string][] = [
    ['调性', song.keyLabel, 'Key'],
    ['拍号', `3/4 · ${song.bpm} BPM`, 'Tempo'],
    ['伴奏', '程序化合成（正式伴奏由外部提供）', 'Audio'],
    ['技巧要求', song.difficulty === 1 ? '基础气息与指法' : '连奏气息 · 中音区 · 弱起处理', `Level ${song.difficulty}`],
  ]

  return (
    <div className="preview">
      <header className="preview-topbar">
        <button className="back-pill" onClick={() => go('home')} aria-label="返回曲库">
          ‹
        </button>
        <div className="logo">
          Syrinx<i style={{ fontStyle: 'normal', color: song.accent }}>·</i>长笛流光
        </div>
      </header>

      <section className="album-hero">
        <div className="glow" style={{ background: `radial-gradient(60% 90% at 28% 40%, ${song.accent}4d, transparent 70%)` }} />
        {/* hero 右侧：3D 长笛展示（加载失败自动回退 CSS 长笛条） */}
        <div className="hero-flute" aria-hidden="true">
          <FluteView accent={song.accent} />
        </div>
        <div className="album-row">
          <div className="cover playing" style={cover}>
            <div className="vinyl-mark">♪</div>
            <div className="cover-note">预览占位 · 每曲 preview.mp4</div>
          </div>
          <div className="album-info">
            <div className="kicker">{song.tags.join(' · ')}</div>
            <h1>{song.title}</h1>
            <div className="album-meta">
              <b>{song.composer}</b>
              <span className="dot-sep">•</span>
              {DIFFICULTY_LABEL[song.difficulty]}
              <span className="dot-sep">•</span>
              {song.durationLabel}
            </div>
            <p className="album-desc">{song.description}</p>
            <div className="action-row">
              <button
                className="btn-play-big"
                style={{ background: song.accent }}
                onClick={() => go('perform', song.id)}
                aria-label="开始演奏"
                title="开始演奏"
              >
                ▶
              </button>
              <button className={`btn-pill${fav ? ' added' : ''}`} onClick={() => toggleFavorite(song.id)}>
                {fav ? '✓ 已收藏' : '＋ 收藏'}
              </button>
              <span className="listen-state">预览伴奏将在演奏页自动播放</span>
            </div>
          </div>
        </div>
      </section>

      <section className="info-list" aria-label="曲目信息">
        {rows.map(([k, v, tag], i) => (
          <div className="info-row" key={k}>
            <span className="idx">{i + 1}</span>
            <span>
              <span className="k">{k}</span>
              <span className="v">{v}</span>
            </span>
            <span className="tag" style={{ color: song.accent, borderColor: `${song.accent}66` }}>
              {tag}
            </span>
          </div>
        ))}
      </section>

      {/* 曲谱预览：静态渲染 + 缩放（M2 起接入伴奏时钟跟随） */}
      <section className="score-section" aria-label="曲谱预览">
        <h3 className="score-section-title">曲谱预览</h3>
        {loadError && <div className="score-load-error">曲谱加载失败：{loadError}</div>}
        {!xml && !loadError && <div className="score-load-error">曲谱加载中…</div>}
        {xml && timeline && (
          <ScoreSheet xml={xml} timeline={timeline} accent={song.accent} zoomControls />
        )}
      </section>

      <footer className="preview-footer">
        曲谱与伴奏素材由用户自备自用，应用不分发。正式伴奏/封面/预览视频按 Song Pack 格式放入 public/songs/{song.id}/。
      </footer>
    </div>
  )
}
