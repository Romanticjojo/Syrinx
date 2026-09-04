import { useEffect, useRef, useState } from 'react'
import About from '../components/About'
import { DIFFICULTY_LABEL, SONGS } from '../songs'
import { assetUrl } from '../lib/assetUrl'
import type { SongManifest } from '../types'
import { useAppStore } from '../store'
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

/** hover 预览延迟：停留超过此时长才开播（避免快速滑过时全量拉流）；已预热的视频直接续播 */
const PREVIEW_DELAY_MS = 200

/** Netflix 式单卡：hover 放大提亮 + 停留后静音视频预览 + 迷你播放按钮 */
function SongCard({ song, onOpen }: { song: SongManifest; onOpen: () => void }) {
  const [previewing, setPreviewing] = useState(false)
  // 首次预览后 <video> 保留预热（暂停而非销毁），再次 hover 直接续播，避免重新拉流
  const [warmed, setWarmed] = useState(false)
  const timer = useRef(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  // play() 被浏览器静默拒绝（首次挂载视频未就绪）时置位，canplay 后补播
  const pendingPlay = useRef(false)

  const stopPreview = () => {
    clearTimeout(timer.current)
    timer.current = 0
    pendingPlay.current = false
    setPreviewing(false)
    videoRef.current?.pause()
  }
  const startPreview = () => {
    if (!song.hoverVideoUrl && !song.backgroundVideoUrl) return
    clearTimeout(timer.current)
    timer.current = window.setTimeout(
      () => {
        setPreviewing(true)
        setWarmed(true)
      },
      warmed ? 0 : PREVIEW_DELAY_MS,
    )
  }
  // 预览态驱动播放：挂载/续播统一走这里（mouseleave 只暂停不卸载）
  useEffect(() => {
    const v = videoRef.current
    if (!v) return
    if (previewing) {
      v.play().catch(() => {
        pendingPlay.current = true
      })
    } else {
      v.pause()
    }
  }, [previewing, warmed])
  // 首次 hover 时 <video> 才挂载、视频未缓冲，play()/autoPlay 都会被浏览器静默拒绝；
  // 等到 canplay（缓冲可播）再补播，二次 hover 走预热续播不受影响
  const handleCanPlay = () => {
    if (!pendingPlay.current || !previewing) return
    pendingPlay.current = false
    videoRef.current?.play().catch(() => {})
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
      <div
        className="art"
        style={{
          ...(song.coverUrl ? undefined : coverStyle(song.accent)),
          ...(song.coverPosition ? { ['--cover-pos' as string]: song.coverPosition } : {}),
        }}
      >
        {(
          <img
            className="art-img"
            src={song.coverUrl ? assetUrl(song.coverUrl) : assetUrl('/brand/flute.jpg')}
            alt=""
            loading="lazy"
            style={positionOf(song)}
          />
        )}
        {/* 预览片段：静音自动播放（muted 满足 WebView 自动播放策略）；预热后隐藏保活 */}
        {warmed && (song.hoverVideoUrl ?? song.backgroundVideoUrl) && (
          <video
            ref={videoRef}
            className="art-preview"
            style={{ visibility: previewing ? 'visible' : 'hidden' }}
            src={assetUrl(song.hoverVideoUrl ?? song.backgroundVideoUrl ?? '')}
            muted
            loop={!(song.playOnce ?? song.hoverPlayOnce)}
            playsInline
            autoPlay
            onCanPlay={handleCanPlay}
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
  const [aboutOpen, setAboutOpen] = useState(false)
  // 同步调试页入口：仅 DEV 或 ?debug=1 可见（不进曲库导航）
  const showSyncTune =
    import.meta.env.DEV || new URLSearchParams(window.location.search).has('debug')


  return (
    <div className="home">
      <header className="home-topbar">
        <div className="home-logo">
          <img src={assetUrl("/brand/syrinx-logo-white.jpg")} alt="" aria-hidden="true" />
          Syrinx
        </div>
        <nav className="home-nav">
          <button className="nav-pill on">曲库</button>
          <button className="nav-pill" onClick={() => setAboutOpen(true)}>
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
          <img className="hero-bg-img" src={assetUrl(featured.coverUrl ?? '')} alt="" style={positionOf(featured)} />
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
      {aboutOpen && <About onClose={() => setAboutOpen(false)} />}
      {showSyncTune && (
        <a className="debug-link" href={`/sync-tune/${featured.id}`}>
          同步调试（beats 微调）
        </a>
      )}
    </div>
  )
}
