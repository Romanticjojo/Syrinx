import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { expandRepeats, parseMusicXml } from './musicxml'

/**
 * Luv Letter Soundslice 精校谱（任务 t_76c0cbff）回归测试：
 * 用户在 Soundslice 精校并导出（software=Soundslice MusicXML exporter）+ m45 时值修复
 * + 6 个 <wavy-line>（m3/m52/m56 首音各 start+stop 成对，演奏序 3/67/75 小节首音）。72 小节印谱、divisions=16、
 * 真实 tempo 标记 76/86/76、7 对反复记号 + volta（一房/二房）。
 * 注：OSMD 真实渲染验证用浏览器 e2e（happy-dom 无 canvas，OSMD 文字测量会崩）。
 */

// happy-dom 的 XML 解析器不支持单引号属性（浏览器/Electron 原生 DOMParser 无此问题），
// Soundslice 导出的声明是单引号——测试读取时归一化，谱面文件本身保持原样
const readScore = () =>
  readFileSync('public/songs/luv-letter/score.musicxml', 'utf-8').replace(
    /^<\?xml[^>]*\?>/,
    (m) => m.replace(/'/g, '"'),
  )

const xml = readScore()

/** 印谱逐小节 duration tick 总和 */
function measureTickSums(src: string): number[] {
  return [...src.matchAll(/<measure number="\d+">([\s\S]*?)<\/measure>/g)].map((m) =>
    [...m[1].matchAll(/<duration>(\d+)<\/duration>/g)].reduce((s, d) => s + Number(d[1]), 0),
  )
}

/** 给印谱小节打 data-orig 标记 → expandRepeats 后读出播放序（印谱小节号） */
function expandedOrder(): number[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  doc.querySelectorAll('part measure').forEach((m) => {
    m.setAttribute('data-orig', m.getAttribute('number') ?? '')
  })
  const expanded = expandRepeats(new XMLSerializer().serializeToString(doc))
  const edoc = new DOMParser().parseFromString(expanded, 'application/xml')
  return Array.from(edoc.querySelectorAll('part measure')).map((m) =>
    Number(m.getAttribute('data-orig')),
  )
}

describe('luv-letter Soundslice 精校谱 timeline', () => {
  it('parseMusicXml：72 小节印谱（+终点标记）、首 tempo 76', () => {
    const tl = parseMusicXml(xml)
    expect(tl.tempo).toBe(76)
    expect(tl.measureTimes.filter((m) => !m.end)).toHaveLength(72)
    expect(tl.measureTimes[72]).toMatchObject({ measure: 73, end: true })
    expect(tl.notes.length).toBeGreaterThan(600)
  })

  it('每小节时值守恒：duration 总和 = 4×divisions（divisions=16 → 64 tick）', () => {
    const divisions = Number(xml.match(/<divisions>(\d+)<\/divisions>/)?.[1])
    expect(divisions).toBe(16)
    const sums = measureTickSums(xml)
    expect(sums).toHaveLength(72)
    for (const [i, sum] of sums.entries()) {
      expect(sum, `m${i + 1}`).toBe(4 * divisions)
    }
  })

  it('m45 时值回归：修复后总和 = 64（Soundslice 原始导出曾超拍）', () => {
    const sums = measureTickSums(xml)
    expect(sums[44]).toBe(64)
  })

  it('vibrato 波浪线仅在 m3/m52/m56 首音（演奏序 3/67/75 小节第一音），start+stop 成对', () => {
    const wavy = xml.match(/<wavy-line[^>]*\/>/g) ?? []
    expect(wavy).toHaveLength(6) // 3 音 × (start+stop)
    for (const mnum of ['3', '52', '56']) {
      const seg = xml.slice(xml.indexOf(`<measure number="${mnum}">`))
      const firstNote = seg.slice(seg.indexOf('<note>'), seg.indexOf('</note>'))
      expect((firstNote.match(/<wavy-line/g) ?? []).length).toBe(2)
    }
    // m70 长音与 m72 终音不再带波浪线（旧错误位置）
    for (const mnum of ['70', '72']) {
      const i = xml.indexOf(`<measure number="${mnum}">`)
      const seg = xml.slice(i, xml.indexOf('</measure>', i))
      expect(seg).not.toContain('wavy-line')
    }
  })

  it('单声部清洗到位：无 backup/chord 残留（Soundslice 导出省略 voice 标签）', () => {
    expect(xml).not.toContain('<backup')
    expect(xml).not.toContain('<chord')
    expect(xml).not.toContain('<voice>')
  })

  it('反复展开：72 小节印谱 → 97 小节播放序（expandRepeats + volta）', () => {
    const order = expandedOrder()
    expect(order).toHaveLength(97)
    // 段1：|: 1-4 |1 4 :| 5（二房子）——一房子 m4 只奏一遍
    expect(order.slice(0, 8)).toEqual([1, 2, 3, 4, 1, 2, 3, 5])
    // 段7：m70 长音 Bb5 所在小节在反复段第二遍再现（SemA：一房子 stop 与 backward 间的无标记小节每遍都奏）
    expect(order.filter((m) => m === 70)).toHaveLength(2)
    expect(order[order.length - 1]).toBe(72)
    // 展开谱仍可解析，时值单调递增
    const tl = parseMusicXml(expandRepeats(xml))
    expect(tl.measureTimes).toHaveLength(98)
  })
})
