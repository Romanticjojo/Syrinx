import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import About from '../components/About'
import Dialog from '../components/Dialog'
import LangSwitch from '../components/LangSwitch'
import HeroCarousel from './HeroCarousel'
import { SONGS } from '../songs'
import { assetUrl } from '../lib/assetUrl'
import { pickSongText, useT } from '../i18n'
import type { SongManifest } from '../types'
import { useAppStore } from '../store'
import './HomePage.css'

const PersonalLibrary = import.meta.env.MODE === 'desktop' ? lazy(() => import('../library/PersonalLibrary')) : null

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
  const t = useT()
  const [previewing, setPreviewing] = useState(false)
  // 首次预览后 <video> 保留预热（暂停而非销毁），再次 hover 直接续播，避免重新拉流
  const [warmed, setWarmed] = useState(false)
  const timer = useRef(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  // play() 被浏览器静默拒绝（首次挂载视频未就绪）时置位，canplay 后补播
  const pendingPlay = useRef(false)
  // 触屏语境（无 hover）：挂载时判定一次（设备能力运行期不变）
  const coarseTouch = useRef(
    typeof window !== 'undefined' &&
      window.matchMedia('(hover: none) and (pointer: coarse)').matches,
  ).current
  const cardRef = useRef<HTMLButtonElement>(null)

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

  // 触屏自动预览（t_e031ae5d 方案 A → 9/8 二轮改循环）：卡片进视口自动开播。
  // 9/8 用户钦定「播放一次就停了，能做成循环的吗」——触屏路径与非 once 曲一律
  // loop 循环（loop 属性原生循环，无 ended）；once 曲（hoverPlayOnce/playOnce）
  // 保持定格语义：播完 ended 保持末帧可见，与桌面 hover 语义一致。离开视口暂停
  // 回封面、再进视口恢复播放（含 once 曲外的所有曲——循环语义下恢复而非重播）。
  // 桌面（hover:hover）不创建 observer，hover 行为零变化。
  useEffect(() => {
    if (!coarseTouch) return
    const el = cardRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) {
            startPreview()
          } else {
            stopPreview()
          }
        }
      },
      { threshold: 0.5 },
    )
    io.observe(el)
    return () => io.disconnect()
    // startPreview/stopPreview 稳定读 refs/state setter，依赖留空
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <button
      className="song-card"
      ref={cardRef}
      onClick={onOpen}
      onMouseEnter={startPreview}
      onMouseLeave={stopPreview}
      onFocus={startPreview}
      onBlur={stopPreview}
      title={`${pickSongText(song, 'title')} · ${pickSongText(song, 'composer')}`}
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
        {/* 预览片段：静音自动播放（muted 满足 WebView 自动播放策略）；预热后隐藏保活。
            触屏（9/8 二轮用户钦定循环）：与非 once 曲一律 loop 循环，无 ended 事件；
            once 曲（hoverPlayOnce/playOnce）loop=false 播完 ended 定格末帧可见，
            离开视口才隐藏——与桌面「hover 定格/移开回封面」语义一致。
            桌面 hover 路径零变化：非 once 曲保持循环。 */}
        {warmed && (song.hoverVideoUrl ?? song.backgroundVideoUrl) && (
          <video
            ref={videoRef}
            className="art-preview"
            style={{ visibility: previewing ? 'visible' : 'hidden' }}
            src={assetUrl(song.hoverVideoUrl ?? song.backgroundVideoUrl ?? '')}
            muted
            loop={!(song.playOnce || song.hoverPlayOnce)}
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
        <div className="t">{pickSongText(song, 'title')}</div>
        <div className="a">{pickSongText(song, 'composer')}</div>
        <div className="diff">
          <span>{t(`difficulty.${song.difficulty}`)}</span>
          <span className="dur">{song.durationLabel}</span>
        </div>
      </div>
    </button>
  )
}

export default function HomePage() {
  const t = useT()
  const go = useAppStore((s) => s.go)
  const featured = SONGS[0]
  const [aboutOpen, setAboutOpen] = useState(false)
  const [editionNotice, setEditionNotice] = useState(false)
  const libraryTab = useAppStore((s) => s.libraryTab)
  const setLibraryTab = useAppStore((s) => s.setLibraryTab)
  const personalOpen = !!PersonalLibrary && libraryTab === 'personal'

  return (
    <div className="home">
      <header className="home-topbar">
        <div className="home-logo">
          <img src={assetUrl("/brand/syrinx-logo-white.jpg")} alt="" aria-hidden="true" />
          Syrinx
        </div>
        <nav className="home-nav">
          <button className="nav-pill on">{t('home.navLibrary')}</button>
          <button className="nav-pill" onClick={() => setAboutOpen(true)}>
            {t('home.navAbout')}
          </button>
          <LangSwitch />
        </nav>
      </header>

      <div className="catalog-tabs-bar"><div className="catalog-tabs" role="tablist" aria-label={t('home.catalogTabsLabel')}>
        <button role="tab" aria-selected={!personalOpen} className={!personalOpen ? 'selected' : ''} onClick={() => setLibraryTab('featured')}>{t('home.tabFeatured')}</button>
        <button role="tab" aria-selected={personalOpen} className={personalOpen ? 'selected' : ''} onClick={() => { if (PersonalLibrary) setLibraryTab('personal'); else setEditionNotice(true) }}>{t('home.tabPersonal')}{!PersonalLibrary && <span className="edition-tab-mark">{t('home.devBadge')}</span>}</button>
      </div></div>

      {personalOpen && PersonalLibrary ? <Suspense fallback={<div className="route-loading" role="status">{t('home.personalLoading')}</div>}><PersonalLibrary /></Suspense> : <>
      {/* 首发英雄位：三曲 Netflix 式轮播，点击任意广告页进入预览 */}
      {featured && <HeroCarousel onOpen={(song) => go('preview', song.id)} />}

      <section className="home-section">
        <h3>{t('home.featured')}</h3>
        {SONGS.length > 0 ? (
          <div className="song-grid">
            {SONGS.map((s) => (
              <SongCard key={s.id} song={s} onOpen={() => go('preview', s.id)} />
            ))}
          </div>
        ) : (
          <div className="catalog-empty" role="status">
            <b>{t('home.emptyTitle')}</b>
            <span>{t('home.emptyBody')}</span>
          </div>
        )}
      </section>
      </>}
      {editionNotice && <Dialog title={t('home.personalDialogTitle')} onClose={() => setEditionNotice(false)}>
        <div className="edition-notice-copy">
          <p>{t('home.personalDialogP1')}</p>
          <p>{t('home.personalDialogP2')}</p>
        </div>
        <div className="dialog-actions"><button className="btn-pill" onClick={() => setEditionNotice(false)}>{t('common.gotIt')}</button></div>
      </Dialog>}
      {aboutOpen && <About onClose={() => setAboutOpen(false)} />}
    </div>
  )
}
