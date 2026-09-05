import { useEffect, useRef, useState } from 'react'
import { DIFFICULTY_LABEL, SONGS } from '../songs'
import { assetUrl } from '../lib/assetUrl'
import type { SongManifest } from '../types'
import './HeroCarousel.css'

/** 参与英雄位轮播的曲目（显式钦定顺序，勿依赖 SONGS 数组序） */
const HERO_IDS = ['luv-letter', 'interstellar', 'expedition-33']
const HERO_SONGS: SongManifest[] = HERO_IDS.flatMap((id) => {
  const song = SONGS.find((s) => s.id === id)
  return song ? [song] : []
})

/** 自动轮播间隔（毫秒）：hover / 页面不可见时暂停，任何切换后重新计时 */
export const AUTOPLAY_MS = 7000
/** crossfade 时长（毫秒）：经 --hero-fade 注入 CSS，单一来源 */
export const CROSSFADE_MS = 600

/** 封面占位：由曲目主题色生成的渐变（与曲库卡片同款） */
function coverStyle(accent: string) {
  return {
    background: `radial-gradient(80% 70% at 30% 25%, ${accent}66, transparent 65%),
      linear-gradient(150deg, ${accent}33, #0c1010 72%)`,
  }
}

/** 构图锚点：封面裁切时保持人物/主体可见（缺省居中） */
const positionOf = (s: SongManifest): React.CSSProperties =>
  s.coverPosition ? { objectPosition: s.coverPosition } : {}

/** 曲库英雄位 Netflix 式轮播：三曲广告页 crossfade 切换 + 自动轮播 + 键盘可达 */
export default function HeroCarousel({ onOpen }: { onOpen: (song: SongManifest) => void }) {
  const [active, setActive] = useState(0)
  // crossfade 中的离场张（-1 = 无）：只在切换的 600ms 内存在，避免多张全叠文字重影
  const [leaving, setLeaving] = useState(-1)
  const [hovering, setHovering] = useState(false)
  const [hidden, setHidden] = useState(false)
  const fadeTimer = useRef(0)

  const n = HERO_SONGS.length
  const current = HERO_SONGS[active]

  /** 切到指定张（越界自动循环）；手动切换本身会重置自动轮播计时（effect 依赖 active） */
  const show = (index: number) => {
    const next = ((index % n) + n) % n
    if (next === active) return
    clearTimeout(fadeTimer.current)
    setLeaving(active)
    setActive(next)
    fadeTimer.current = window.setTimeout(() => setLeaving(-1), CROSSFADE_MS)
  }

  // 页面不可见时暂停自动轮播（切回来重新计时）
  useEffect(() => {
    const onVis = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // 自动轮播：hover / 页面隐藏时暂停；任何切换（含手动）后重新倒计时
  useEffect(() => {
    if (hovering || hidden) return
    const t = window.setTimeout(() => show(active + 1), AUTOPLAY_MS)
    return () => clearTimeout(t)
  }, [active, hovering, hidden])

  // 卸载清残留定时器，避免离场回调打到已卸载组件
  useEffect(() => () => clearTimeout(fadeTimer.current), [])

  return (
    <section
      className="home-hero"
      style={{ ['--hero-fade' as string]: `${CROSSFADE_MS}ms` }}
      onClick={() => onOpen(current)}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') {
          e.preventDefault()
          show(active + 1)
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault()
          show(active - 1)
        } else if (e.key === 'Enter' && e.target === e.currentTarget) {
          // Enter 仅在 hero 自身聚焦时进详情；焦点在内部按钮（箭头/圆点/播放）时由按钮自己响应
          onOpen(current)
        }
      }}
      aria-label={`轮播推荐，当前 ${current.title}，第 ${active + 1} / ${n} 曲`}
    >
      {/* 仅渲染当前张 + 切换中的离场张（版式类 hero-bg/shade/body 等沿用 HomePage.css） */}
      {HERO_SONGS.map((song, i) =>
        i === active || i === leaving ? (
          <div
            key={song.id}
            className={`hero-slide${i === active ? ' is-active' : ' is-leaving'}`}
            aria-hidden={i !== active}
          >
            <div className="hero-bg" style={coverStyle(song.accent)} />
            {song.coverUrl && (
              <img
                className="hero-bg-img"
                src={assetUrl(song.coverUrl)}
                alt=""
                style={positionOf(song)}
              />
            )}
            <div className="hero-shade" />
            <div className="hero-body">
              <div className="kicker">{song.tags.join(' · ')}</div>
              <h1>{song.title}</h1>
              <div className="meta">
                <b>{song.composer}</b> · {DIFFICULTY_LABEL[song.difficulty]} · {song.durationLabel}
              </div>
              <p className="desc">{song.description}</p>
              <div className="hero-play">
                <button
                  className="btn-play-big"
                  style={{ background: song.accent }}
                  aria-label={`开始预览 ${song.title}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onOpen(song)
                  }}
                >
                  ▶
                </button>
              </div>
            </div>
          </div>
        ) : null,
      )}

      {/* 左右切换：贴边垂直居中，点击不触发进详情 */}
      <button
        className="hero-arrow prev"
        aria-label="上一首"
        onClick={(e) => {
          e.stopPropagation()
          show(active - 1)
        }}
      >
        ‹
      </button>
      <button
        className="hero-arrow next"
        aria-label="下一首"
        onClick={(e) => {
          e.stopPropagation()
          show(active + 1)
        }}
      >
        ›
      </button>

      {/* 指示点：当前张以曲目 accent 点亮，点击直达 */}
      <div className="hero-dots">
        {HERO_SONGS.map((song, i) => (
          <button
            key={song.id}
            className={`hero-dot${i === active ? ' on' : ''}`}
            style={i === active ? { ['--dot' as string]: song.accent } : undefined}
            aria-label={`切到 ${song.title}`}
            aria-current={i === active}
            onClick={(e) => {
              e.stopPropagation()
              show(i)
            }}
          />
        ))}
      </div>
    </section>
  )
}
