import { useEffect, useRef, useState } from 'react'
import About from '../components/About'
import { DIFFICULTY_LABEL, SONGS } from '../songs'
import type { SongManifest } from '../types'
import { useAppStore } from '../store'
import { getTheme, setTheme } from '../theme'
import './HomePage.css'

/** 封面占位：由曲目主题色生成的渐变（正式封面由 Song Pack 提供 cover 字段） */
function coverStyle(accent: string) {
  return {
    background: `radial-gradient(80% 70% at 30% 25%, ${accent}66, transparent 65%),
      linear-gradient(150deg, ${accent}33, #0c1010 72%)`,
  }
}

/** 构图锚点：封面裁切时保持人物/主体可见（缺省居中） */
const positionOf = (s: SongManifest): React.CSSProperties =>
  s.coverPosition ? { objectPosition: s.coverPosition } : {}

/** hover 预览延迟：停留超过此时长才挂载 <video>（避免快速滑过时全量拉流） */
const PREVIEW_DELAY_MS = 500

/** Netflix 式单卡：hover 放大提亮 + 停留后静音视频预览 + 迷你播放按钮 */
function SongCard({ song, onOpen }: { song: SongManifest; onOpen: () => void }) {
  const [previewing, setPreviewing] = useState(false)
  const timer = useRef(0)

  const stopPreview = () => {
    clearTimeout(timer.current)
    timer.current = 0
    setPreviewing(false)
  }
  const startPreview = () => {
    if (!song.backgroundVideoUrl) return
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setPreviewing(true), PREVIEW_DELAY_MS)
  }
  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <button
      className="song-card"
      onClick={onOpen}
      onMouseEnter={startPreview}
      onMouseLeave={stopPreview}
      onFocus={startPreview}
      onBlur={stopPreview}
      title={`${song.title} · ${song.composer}`}
    >
      <div className="art" style={song.coverUrl ? undefined : coverStyle(song.accent)}>
        {song.coverUrl && (
          <img
            className="art-img"
            src={song.coverUrl}
            alt=""
            loading="lazy"
            style={positionOf(song)}
          />
        )}
        {/* 预览片段：静音自动播放（muted 满足 WebView 自动播放策略），离开即卸载 */}
        {previewing && song.backgroundVideoUrl && (
          <video
            className="art-preview"
            src={song.backgroundVideoUrl}
            muted
            loop
            playsInline
            autoPlay
            aria-hidden="true"
          />
        )}
        <span className="art-veil" aria-hidden="true" />
        <span className="mini-play" style={{ background: song.accent }} aria-hidden="true">
          ▶
        </span>
      </div>
      <div className="card-info">
        <div className="t">{song.title}</div>
        <div className="a">{song.composer}</div>
        <div className="diff">
          <span>{DIFFICULTY_LABEL[song.difficulty]}</span>
          <span className="dur">{song.durationLabel}</span>
        </div>
      </div>
    </button>
  )
}

export default function HomePage() {
  const go = useAppStore((s) => s.go)
  const featured = SONGS[0]
  const [theme, setThemeState] = useState(() => getTheme())
  const [aboutOpen, setAboutOpen] = useState(false)

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    setThemeState(next)
  }

  return (
    <div className="home">
      <header className="home-topbar">
        <div className="home-logo">
          <img className="home-mark" src="/brand/syrinx-logo-dark.jpg" alt="" aria-hidden="true" />
          Syrinx<i>·</i>长笛流光
        </div>
        <nav className="home-nav">
          <button className="nav-pill on">曲库</button>
          <button className="nav-pill">收藏</button>
          <button className="nav-pill">我的录音</button>
          <button className="nav-pill ghost" onClick={toggleTheme} aria-label="切换深浅主题" title="切换深浅主题">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
          <button className="nav-pill ghost" onClick={() => setAboutOpen(true)}>
            关于
          </button>
        </nav>
      </header>

      {/* 首发英雄位：点击进入预览 */}
      <section
        className="home-hero"
        onClick={() => go('preview', featured.id)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && go('preview', featured.id)}
        aria-label={`进入 ${featured.title} 预览`}
      >
        <div className="hero-bg" style={coverStyle(featured.accent)} />
        {featured.coverUrl && (
          <img className="hero-bg-img" src={featured.coverUrl} alt="" style={positionOf(featured)} />
        )}
        <div className="hero-shade" />
        <div className="hero-body">
          <div className="kicker">{featured.tags.join(' · ')}</div>
          <h1>{featured.title}</h1>
          <div className="meta">
            <b>{featured.composer}</b> · {DIFFICULTY_LABEL[featured.difficulty]} · {featured.durationLabel}
          </div>
          <p className="desc">{featured.description}</p>
          <div className="hero-play">
            <button
              className="btn-play-big"
              aria-label="开始预览"
              onClick={(e) => {
                e.stopPropagation()
                go('preview', featured.id)
              }}
            >
              ▶
            </button>
          </div>
        </div>
      </section>

      <section className="home-section">
        <h3>曲库</h3>
        <div className="song-grid">
          {SONGS.map((s) => (
            <SongCard key={s.id} song={s} onOpen={() => go('preview', s.id)} />
          ))}
        </div>
      </section>

      <footer className="home-footer">
        <div className="footer-brand">
          <img src="/brand/syrinx-logo-dark.jpg" alt="" aria-hidden="true" />
          <span>Syrinx · 长笛演奏辅助 —— 曲谱跟随 · 伴奏同步 · 录音回放 · 音高反馈</span>
        </div>
        <div className="footer-meta">
          曲谱与伴奏素材由用户自备自用，应用不分发。
          <button className="footer-about" onClick={() => setAboutOpen(true)}>
            关于 Syrinx
          </button>
        </div>
      </footer>

      {aboutOpen && <About onClose={() => setAboutOpen(false)} />}
    </div>
  )
}
