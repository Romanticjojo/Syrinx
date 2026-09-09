import { useEffect, useRef, useState, type ReactNode } from 'react'
import ScoreSheet from '../components/ScoreSheet'
import { cancelPendingAccompaniment, preloadAccompaniment } from '../audio/accompaniment'
import { DIFFICULTY_LABEL, getSong, loadSong, SONGS } from '../songs'
import { assetUrl } from '../lib/assetUrl'
import { expandRepeats, stripForcedBreaks } from '../score/musicxml'
import { useAppStore } from '../store'
import type { SongManifest, Timeline } from '../types'
import './PreviewPage.css'

/** 封面占位渐变（与目录页一致，正式封面由 Song Pack 提供） */
function placeholderStyle(accent: string) {
  return {
    background: `radial-gradient(80% 70% at 30% 25%, ${accent}66, transparent 65%),
      linear-gradient(150deg, ${accent}33, #0c1010 72%)`,
  }
}
/** 详情页大封面占位：与曲库卡片 coverStyle 同款（无封面时垫 accent 渐变再贴 flute 图） */
const coverStyle = placeholderStyle

/** 构图锚点：封面裁切时保持人物/主体可见（缺省居中） */
const positionOf = (s: SongManifest): React.CSSProperties =>
  s.coverPosition ? { objectPosition: s.coverPosition } : {}

/** 曲谱版本（interstellar 拼谱修复 t_7518c69e）：flute = 主谱（scoreUrl，现状）；
 *  piano = 钢琴伴奏谱（pianoScoreUrl，大谱表）。纯 UI 态，切曲重置回 flute */
type ScoreKind = 'flute' | 'piano'

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
  // 钢琴伴奏谱（懒加载，首次切换才拉取；失败走独立错误态，可切回长笛谱）
  const [scoreKind, setScoreKind] = useState<ScoreKind>('flute')
  const [pianoXml, setPianoXml] = useState<string | null>(null)
  const [pianoError, setPianoError] = useState<string | null>(null)
  const [accompanimentState, setAccompanimentState] = useState<'waiting' | 'loading' | 'ready' | 'synthesized' | 'error'>('waiting')
  const [preloadAttempt, setPreloadAttempt] = useState(0)
  const handoffToPerformRef = useRef(false)
  // 切曲时重置加载状态（渲染期间调整状态，避免 effect 内 setState 级联渲染）
  const [lastSongId, setLastSongId] = useState(song.id)
  const bgVideoRef = useRef<HTMLVideoElement>(null)
  if (lastSongId !== song.id) {
    setLastSongId(song.id)
    setXml(null)
    setTimeline(null)
    setLoadError(null)
    setScoreKind('flute')
    setPianoXml(null)
    setPianoError(null)
    setAccompanimentState('waiting')
    setPreloadAttempt(0)
  }

  // 进入/切曲即回顶（t_e031ae5d Bug3）：滚动器是 document（.preview 自身无
  // 约束不滚），组件复用不 remount——底部 more-card 切曲、首页长滚进详情都
  // 带着旧 scrollTop（长→短谱曲视觉即「贴底」）。谱面异步加载期间无人改写
  // scrollTop，归零后保持为 0。
  useEffect(() => {
    document.scrollingElement?.scrollTo(0, 0)
  }, [song.id])

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

  // 谱面时间轴就绪后只准备当前曲目。演奏页调用同一 loader 时会接续这里的
  // 下载/解码结果；普通离开取消未完成项，同曲进入演奏页则保留并交接。
  useEffect(() => {
    if (!timeline) return
    let alive = true
    preloadAccompaniment(song, timeline).then(
      ({ synthesized }) => {
        if (alive) setAccompanimentState(synthesized ? 'synthesized' : 'ready')
      },
      (error: unknown) => {
        if (alive && (!(error instanceof Error) || error.name !== 'AbortError')) {
          setAccompanimentState('error')
        }
      },
    )
    return () => {
      alive = false
      if (!handoffToPerformRef.current) cancelPendingAccompaniment(song.id)
      handoffToPerformRef.current = false
    }
  }, [song, timeline, preloadAttempt])

  // 钢琴伴奏谱懒加载：首次切到 piano 才拉取。timeline 复用长笛谱的——两谱同曲
  // 同小节同时间轴（Soundslice 拼谱交付口径），预览为静态渲染无光标推进，
  // timeline 仅作 ScoreSheet/OSMD load 侧输入；预处理与 loadSong 同口径
  useEffect(() => {
    if (scoreKind !== 'piano' || pianoXml || pianoError || !song.pianoScoreUrl) return
    let alive = true
    ;(async () => {
      try {
        const url = song.pianoScoreUrl!
        const res = await fetch(assetUrl(url))
        if (!res.ok) throw new Error(`曲谱加载失败：${url}（HTTP ${res.status}）`)
        const x = expandRepeats(stripForcedBreaks(await res.text()))
        if (alive) setPianoXml(x)
      } catch (e: unknown) {
        if (alive) setPianoError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [scoreKind, pianoXml, pianoError, song])

  const cover = {
    background: `radial-gradient(70% 55% at 30% 28%, rgba(255,255,255,.13), transparent 60%),
      radial-gradient(90% 80% at 75% 85%, ${song.accent}73, transparent 65%),
      linear-gradient(150deg, ${song.accent}2e, #0c1210 70%)`,
  }

  // 全屏背景视频：挂载即静音循环播放，切曲/卸载时暂停（muted 满足自动播放策略）
  useEffect(() => {
    const v = bgVideoRef.current
    if (!v) return
    v.play().catch(() => {})
    return () => v.pause()
  }, [song.backgroundVideoUrl])
  // 当前谱面：按版本取 xml/错误（钢琴谱懒加载期间显示既有「曲谱加载中…」占位）
  const activeXml = scoreKind === 'flute' ? xml : pianoXml
  const activeError = scoreKind === 'flute' ? loadError : pianoError

  // 规格条数据：签名的结构化形态（调性/速度/伴奏/技巧），难度徽章复用曲库 ●●● 标记
  const specs: { label: string; en: string; value: ReactNode; valueClass?: string; badge?: string }[] = [
    { label: '调性', en: 'KEY', value: song.keyLabel },
    {
      label: '速度',
      en: 'TEMPO',
      value: (
        <>
          {song.bpm}
          <span className="bpm-unit">BPM</span>
        </>
      ),
      valueClass: 'spec-value-tempo',
    },
    { label: '伴奏', en: 'AUDIO', value: song.accompanimentUrl ? '钢琴伴奏' : '程序化合成伴奏' },
    {
      label: '技巧要求',
      en: 'TECHNIQUE',
      value: song.difficulty === 1 ? '基础气息与指法' : '连奏气息 · 中音区 · 弱起处理',
      badge: `难度 ${DIFFICULTY_LABEL[song.difficulty]}`,
    },
  ]

  return (
    <div className="preview">
      {/* 全屏背景层：动画视频/封面铺满（object-fit cover）+ accent 青绿调模糊垫底 + 暗部纱罩 */}
      <div className="preview-bg" aria-hidden="true">
        <div
          className="preview-bg-pad"
          style={{
            background: `radial-gradient(75% 60% at 32% 28%, ${song.accent}59, transparent 72%),
              linear-gradient(160deg, #10201c, #0a0d0c 70%)`,
          }}
        />
        {song.backgroundVideoUrl ? (
          <video
            className="preview-bg-media"
            ref={bgVideoRef}
            src={assetUrl(song.backgroundVideoUrl)}
            muted
            loop={!song.playOnce}
            playsInline
            autoPlay
          />
        ) : song.coverUrl ? (
          <img className="preview-bg-media" src={assetUrl(song.coverUrl ?? '')} alt="" style={positionOf(song)} />
        ) : null}
        <div className="preview-bg-scrim" />
      </div>

      <header className="preview-topbar">
        <div className="topbar-left">
          <button className="back-ghost" onClick={() => go('home')} aria-label="返回曲库">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="logo">
            <img src={assetUrl("/brand/syrinx-logo-white.jpg")} alt="" aria-hidden="true" />
            Syrinx
          </div>
        </div>
      </header>

      <section className="album-hero">
        <div className="glow" style={{ background: `radial-gradient(60% 90% at 28% 40%, ${song.accent}4d, transparent 70%)` }} />
        {/* hero 右侧：3D 长笛展示（加载失败自动回退 CSS 长笛条） */}
        <div className="album-row">
          <div className="cover playing" style={{ ...cover, ...(song.coverUrl ? undefined : coverStyle(song.accent)) }}>
            {/* 无封面回退：与曲库卡片一致——accent 渐变垫底 + 品牌 flute 图（正式封面由 Song Pack 提供 cover 字段） */}
            <img
              className="cover-img"
              src={assetUrl(song.coverUrl ?? '/brand/flute.jpg')}
              alt={`${song.title} 封面`}
              style={song.coverUrl ? positionOf(song) : undefined}
            />
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
                onClick={() => {
                  handoffToPerformRef.current = true
                  go('perform', song.id)
                }}
                aria-label="开始演奏"
                title="开始演奏"
              >
                ▶
              </button>
              <span className={`accompaniment-state ${accompanimentState}`} role="status">
                {accompanimentState === 'ready' && '伴奏已准备，可以开始演奏'}
                {accompanimentState === 'synthesized' && '真实伴奏不可用，已准备合成伴奏'}
                {(accompanimentState === 'waiting' || accompanimentState === 'loading') && '正在提前准备伴奏…'}
                {accompanimentState === 'error' && (
                  <>
                    伴奏预载失败，开始演奏时仍会重试
                    <button
                      type="button"
                      onClick={() => {
                        setAccompanimentState('loading')
                        setPreloadAttempt((value) => value + 1)
                      }}
                    >
                      重试
                    </button>
                  </>
                )}
              </span>
              {/* 收藏与伴奏提示：暂时隐藏（功能未上线） */}
              {false && (
                <>
                  <button className={`btn-pill${fav ? ' added' : ''}`} onClick={() => toggleFavorite(song.id)}>
                    {fav ? '✓ 已收藏' : '＋ 收藏'}
                  </button>
                  <span className="listen-state">预览伴奏将在演奏页自动播放</span>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="info-list" aria-label="曲目信息">
        <div className="spec-grid">
          {specs.map(({ label, en, value, valueClass, badge }) => (
            <div className="spec" key={label}>
              <span className="spec-eyebrow">
                <span className="spec-cn">{label}</span>
                <span className="spec-en">{en}</span>
              </span>
              <span className={`spec-value${valueClass ? ` ${valueClass}` : ''}`}>{value}</span>
              {badge && (
                <span className="spec-badge" style={{ color: song.accent, borderColor: `${song.accent}66` }}>
                  {badge}
                </span>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* 曲谱预览：静态渲染 + 缩放（M2 起接入伴奏时钟跟随）；声明了 pianoScoreUrl
          的曲可切「钢琴伴奏谱」大谱表（interstellar 拼谱修复 t_7518c69e），其余曲零变化 */}
      <section className="score-section" aria-label="曲谱预览">
        <h3 className="score-section-title">
          曲谱预览
          {song.pianoScoreUrl && (
            <div className="score-switch" role="group" aria-label="曲谱版本">
              <button
                className={`seg${scoreKind === 'flute' ? ' on' : ''}`}
                aria-pressed={scoreKind === 'flute'}
                onClick={() => setScoreKind('flute')}
              >
                长笛谱
              </button>
              <button
                className={`seg${scoreKind === 'piano' ? ' on' : ''}`}
                aria-pressed={scoreKind === 'piano'}
                onClick={() => setScoreKind('piano')}
              >
                钢琴伴奏谱
              </button>
            </div>
          )}
        </h3>
        {activeError && <div className="score-load-error">曲谱加载失败：{activeError}</div>}
        {!activeXml && !activeError && <div className="score-load-error">曲谱加载中…</div>}
        {activeXml && timeline && (
          <ScoreSheet xml={activeXml} timeline={timeline} accent={song.accent} zoom={0.85} />
        )}
      </section>

      {/* 更多曲目：详情页 ↔ 目录页双向打通 */}
      <section className="more-songs" aria-label="更多曲目">
        <h3 className="score-section-title">继续浏览</h3>
        <div className="more-strip">
          {SONGS.filter((x) => x.id !== song.id).map((x) => (
            <button key={x.id} className="more-card" onClick={() => go('preview', x.id)} title={x.title}>
              <div className="more-art" style={x.coverUrl ? undefined : placeholderStyle(x.accent)}>
                {x.coverUrl && <img src={assetUrl(x.coverUrl)} alt="" loading="lazy" style={positionOf(x)} />}
                <span className="more-veil" aria-hidden="true" />
              </div>
              <div className="more-name">{x.title}</div>
              <div className="more-meta">
                {x.composer} · {x.durationLabel}
              </div>
            </button>
          ))}
        </div>
      </section>

      <footer className="preview-footer">
        曲谱与伴奏素材由用户自备自用，应用不分发。正式伴奏/封面/预览视频按 Song Pack 格式放入 public/songs/{song.id}/。
      </footer>
    </div>
  )
}
