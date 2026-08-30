/** 曲目音符事件：时间轴的最小单元（单位均为秒） */
export interface NoteEvent {
  /** 相对曲目开始的起始时间 */
  time: number
  /** 时值长度 */
  duration: number
  /** MIDI 音高（60 = C4） */
  midi: number
  /** 所属小节号（从 1 开始） */
  measure: number
}

/** MusicXML 解析出的统一时间轴：谱/音/光标的共同数据源 */
export interface Timeline {
  /** 全曲时长（末音符结束时间） */
  durationSec: number
  /** 一个四分音符的秒数（由首个 tempo 决定；MVP 假定全曲恒速） */
  secPerQuarter: number
  /** 四分音符速度（BPM） */
  tempo: number
  notes: NoteEvent[]
  /** 每小节起始时间表 */
  measureTimes: { measure: number; time: number }[]
}

/** 一次演奏会话的产出（录音 + 音高分析） */
export interface Take {
  songId: string
  startedAt: number
  durationSec: number
  /** 录音回放地址（ObjectURL） */
  audioUrl: string
  mimeType: string
  /** 演奏时长内实测的音高轨迹（时间 → 频率/音分偏移） */
  pitchTrack: PitchPoint[] | null
  /** 音准统计（无法分析时为 null） */
  stats: TuneStats | null
}

export interface PitchPoint {
  time: number
  hz: number
  /** 相对目标音高的音分偏移（无目标时为 0） */
  cents: number
}

export interface TuneStats {
  /** ±50 音分内的音符占比（0-1） */
  inTuneRatio: number
  /** 全部音符平均音分偏差绝对值 */
  avgAbsCents: number
  /** 参与统计的音符数（无实测样本的音符不计） */
  noteCount: number
}

/** 曲目包元数据（Song Pack manifest） */
export interface SongManifest {
  id: string
  title: string
  composer: string
  /** 1 入门 / 2 进阶 / 3 演奏级 */
  difficulty: 1 | 2 | 3
  durationLabel: string
  keyLabel: string
  description: string
  tags: string[]
  /** MusicXML 地址（必选） */
  scoreUrl: string
  /** 外部伴奏音频（可选；缺省用曲谱程序化合成） */
  accompanimentUrl?: string
  /** 每曲动态背景视频（可选；缺省用 three.js 主题背景） */
  backgroundVideoUrl?: string
  /** 每曲封面图（可选；缺省用 accent 渐变） */
  coverUrl?: string
  /** 封面构图锚点（object-position，宽幅裁切时保持人物/主体可见；缺省居中） */
  coverPosition?: string
  /** 每曲主题色：驱动背景/光标/高亮/强调元素 */
  accent: string
  backgroundTheme: 'lumiere' | 'aurora' | 'ember'
  bpm: number
}
