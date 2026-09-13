/** 光标时间轴数据源（PlanB T2）：anchors = beats.json 伴奏锚点（缺省，现有行为）；
 * score = 谱面确定性时值换算（deterministic-adapter，不依赖音频对齐） */
export type CursorMode = 'anchors' | 'score'

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
  /** 首个速度下一个四分音符的秒数；无精确速度段时用于回退换算 */
  secPerQuarter: number
  /** 四分音符速度（BPM） */
  tempo: number
  notes: NoteEvent[]
  /** 精确速度段（按 quarters 递增，从 0 开始），支持小节内变速。
   *  缺省时沿用精选乐谱的 measureTimes 伴奏锚点插值。 */
  tempoSegments?: { quarters: number; time: number; bpm: number }[]
  /**
   * 每小节起始时间表。quarters = 小节起点的四分音符位置（OSMD cursor
   * RealValue 为全音符，需乘 4），供光标按小节分段插值推进；末项为全曲终点标记
   * （end: true，measure 号为虚构的末小节+1），不是真实小节。
   */
  measureTimes: { measure: number; time: number; quarters: number; end?: true }[]
}

/** 一次演奏会话的产出（录音 + 音高分析） */
export interface Take {
  /** 创建本次演奏时生成的标识；异步保存/分析只能写回同一会话 */
  sessionId: string
  songId: string
  startedAt: number
  durationSec: number
  /** 录音回放地址（ObjectURL） */
  audioUrl: string
  mimeType: string
  /** 录音起点对应的伴奏时间（秒）：起奏即录为 0；回开头重录/中途开录为当时进度 */
  startSec: number
  /** 录音停止对应的伴奏时间（秒） */
  stopSec: number
  /** Fixed accompaniment speed for this segment; absent in older takes means 1. */
  playbackRate?: number
  /** 演奏时长内实测的音高轨迹（时间 → 频率/音分偏移） */
  pitchTrack: PitchPoint[] | null
  /** 音准统计（无法分析时为 null） */
  stats: TuneStats | null
}

/** 一次演奏会话中可独立回放、分析的连续录音段。 */
export interface PerformanceSegment extends Take {
  /** 会话内单调生成的唯一段编号，异步结果必须凭此写回。 */
  id: string
}

export interface PitchPoint {
  time: number
  hz: number
  /** 相对目标音高的音分偏移（无目标时为 0） */
  cents: number
}

export interface TuneStats {
  /** 在成功测得音高的音符中，±50 音分内的比例（0-1） */
  inTuneRatio: number
  /** 成功测得音高的音符平均音分偏差绝对值 */
  avgAbsCents: number
  /** 参与统计的音符数（无实测样本的音符不计） */
  noteCount: number
  /** 本次实际采集区间内的目标音符总数 */
  totalNoteCount: number
  /** 采集区间内没有有效音高样本的目标音符数 */
  missedNoteCount: number
  /** 成功测得音高的目标音符覆盖率（0-1） */
  coverageRatio: number
}

export type PerformanceStatus =
  | 'preparing'
  | 'recording'
  | 'saving'
  | 'completed'
  | 'no-recording'
  | 'failed'

export interface PerformanceSession {
  id: string
  songId: string
  status: PerformanceStatus
  take: Take | null
  /** 已完成封存的全部录音段；take 始终兼容地指向最后一段。 */
  segments: PerformanceSegment[]
  message?: string
}

/** 曲目包元数据（Song Pack manifest） */
export interface SongManifest {
  id: string
  /** Personal songs are supplied by a local runtime source, never fetched from a server. */
  source?: 'personal'
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
  /** 钢琴伴奏谱地址（可选，interstellar 拼谱修复 t_7518c69e）：大谱表 MusicXML，
   *  供预览页「钢琴伴奏谱」切换查看；未声明的曲不显示切换器，行为零变化 */
  pianoScoreUrl?: string
  /** 外部伴奏音频（可选；缺省用曲谱程序化合成） */
  accompanimentUrl?: string
  /** 每曲动态背景视频（可选；缺省用 three.js 主题背景） */
  backgroundVideoUrl?: string
  previewVideoUrl?: string
  /** 演奏页背景视频 contain 留边垫底色（可选；缺省取 luv-letter 视频主背景色以保持原观感） */
  backgroundPadColor?: string
  /** 曲库卡片 hover 预览专用：与封面同构图的方形原版视频（镜头不动，人物原地动起来） */
  hoverVideoUrl?: string
  /** 视频（背景+悬停）播放一次后定格最后一帧，不循环（缺省循环播放） */
  playOnce?: boolean
  /** 仅曲库卡片 hover 预览播放一次后定格末帧（详情/演奏页背景不受影响）；优先级低于 playOnce */
  hoverPlayOnce?: boolean
  /** 演奏页背景视频铺放方式：contain=完整显示留边垫底色（缺省，人物主体曲），cover=铺满裁切（无独占主体的风景/星空曲） */
  backgroundFit?: 'contain' | 'cover'
  /** 每曲封面图（可选；缺省用 accent 渐变） */
  coverUrl?: string
  /** 伴奏锚点文件（可选；离线分析伴奏生成，供伴奏驱动光标，见 score/anchors.ts） */
  beatsUrl?: string
  /**
   * 谱面-伴奏整体对齐微调（毫秒，可选，默认 0）：正 = 谱面整体延后。
   * 锚点标定后的残差按此字段手工校准，替代改动 beats.json（t_b3080db9）。
   */
  anchorOffsetMs?: number
  /** 封面构图锚点（object-position，宽幅裁切时保持人物/主体可见；缺省居中） */
  coverPosition?: string
  /** 每曲主题色：驱动背景/光标/高亮/强调元素 */
  accent: string
  backgroundTheme: 'lumiere' | 'aurora' | 'ember'
  bpm: number
  /**
   * 光标数据源（可选，PlanB T2）：缺省 'anchors'（现有行为零变化）。
   * 'score' = 谱面确定性时值换算；运行时可用 loadSong 第二参数覆盖（T3 A/B 对比）。
   */
  cursorMode?: CursorMode
}
