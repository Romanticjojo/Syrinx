import { DIFFICULTY_LABEL, SONGS } from '../songs'
import { useAppStore } from '../store'
import './HomePage.css'

/** 封面占位：由曲目主题色生成的渐变（正式封面由 Song Pack 提供 cover 字段） */
function coverStyle(accent: string) {
  return {
    background: `radial-gradient(80% 70% at 30% 25%, ${accent}66, transparent 65%),
      linear-gradient(150deg, ${accent}33, #0c1010 72%)`,
  }
}

export default function HomePage() {
  const go = useAppStore((s) => s.go)
  const featured = SONGS[0]

  return (
    <div className="home">
      <header className="home-topbar">
        <div className="home-logo">
          Syrinx<i>·</i>长笛流光
        </div>
        <nav className="home-nav">
          <button className="nav-pill on">曲库</button>
          <button className="nav-pill">收藏</button>
          <button className="nav-pill">我的录音</button>
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
        {featured.coverUrl && <img className="hero-bg-img" src={featured.coverUrl} alt="" />}
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
            <button
              key={s.id}
              className="song-card"
              onClick={() => go('preview', s.id)}
              title={`${s.title} · ${s.composer}`}
            >
              <div className="art" style={s.coverUrl ? undefined : coverStyle(s.accent)}>
                {s.coverUrl && (
                  <img className="art-img" src={s.coverUrl} alt="" loading="lazy" />
                )}
                <span
                  className="mini-play"
                  style={{ background: s.accent }}
                  aria-hidden="true"
                >
                  ▶
                </span>
              </div>
              <div className="t">{s.title}</div>
              <div className="a">{s.composer}</div>
              <div className="diff">
                {DIFFICULTY_LABEL[s.difficulty]} · {s.durationLabel}
              </div>
            </button>
          ))}
        </div>
      </section>

      <footer className="home-footer">
        Syrinx · 长笛演奏辅助 —— 曲谱跟随 · 伴奏同步 · 录音回放 · 音高反馈。曲谱与伴奏素材由用户自备自用，应用不分发。
      </footer>
    </div>
  )
}
