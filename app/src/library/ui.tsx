import type { ReactNode } from 'react'

const paths: Record<string, ReactNode> = {
  folder: <path d="M3 6h7l2 2h9v12H3zM3 6V4h7l2 2h9v2" />,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></>,
  list: <path d="M8 5h13M8 12h13M8 19h13M3 5h1M3 12h1M3 19h1" />,
  add: <path d="M12 5v14M5 12h14" />,
  upload: <><path d="M12 16V3m-4 4 4-4 4 4M4 15v5h16v-5" /></>,
  download: <><path d="M12 3v13m-4-4 4 4 4-4M4 17v4h16v-4" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  back: <path d="m14 5-7 7 7 7" />,
  star: <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z" />,
  sheet: <><path d="M5 3h10l4 4v14H5zM15 3v5h4M8 12h8M8 15h8M8 18h5" /></>,
  play: <path d="m8 4 12 8-12 8Z" />,
  check: <path d="m5 12 4 4L19 6" />,
  lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
  edit: <><path d="m14 4 6 6M4 20l5-1L21 7l-4-4L5 15Z" /></>,
}

export function Icon({ name, size = 19 }: { name: string; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.sheet}</svg>
}

/** A typographic book cover, intentionally distinct from a rendered musical score. */
export function ScoreCover({ title, composer, mode, large = false, image }: { title: string; composer: string; mode?: string; large?: boolean; image?: string | null }) {
  return <div className={`score-cover${large ? ' score-cover-large' : ''}${image ? ' has-cover-image' : ''}`} aria-hidden="true">
    {image && <img className="cover-image" src={image} alt="" loading="lazy" decoding="async" />}
    <div className="cover-edition">SYRINX <span>PERSONAL COLLECTION</span></div>
    <div className="cover-title">{title}</div>
    <div className="cover-composer">{composer || '我的乐谱'}</div>
    <div className="cover-staves"><i /><i /><i /><i /><i /></div>
    <div className="cover-footer"><span>{mode === 'original' ? 'PIANO SCORE' : 'SHEET MUSIC'}</span><Icon name="sheet" size={20} /></div>
  </div>
}
