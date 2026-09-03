import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { SongManifest } from '../types'
import { expandRepeats, parseMusicXml, stripForcedBreaks } from '../score/musicxml'
import type { BeatsFile } from '../score/anchors'

/** 产线二期接入的四首新曲（t_0ad1f095）：manifest 必填字段、beats 结构、
 * 谱面可解析三道闸。媒体不入库，跑此测试前需按 Song Pack 格式放置
 * public/songs/<id>/（与 luv-letter 同结构）。 */
const NEW_SONGS = ['flower-dance', 'river-flows-in-you', 'expedition-33', 'birds-poem'] as const

// happy-dom 的 XML 解析器不支持单引号属性（浏览器/Electron 原生 DOMParser 无此问题，
// 与 omr-check.test.ts 的 luv-letter 处理一致）：OMR 导出的声明是单引号，读取时归一化，
// 谱面文件本身保持原样
const readScore = (id: string) =>
  readFileSync(`public/songs/${id}/score.musicxml`, 'utf-8').replace(
    /^<\?xml[^>]*\?>/,
    (m) => m.replace(/'/g, '"'),
  )

describe.each(NEW_SONGS)('新曲结构合法性：%s', (id) => {
  const manifest: SongManifest = JSON.parse(
    readFileSync(`public/songs/${id}/manifest.json`, 'utf-8'),
  )
  const beats: BeatsFile = JSON.parse(readFileSync(`public/songs/${id}/beats.json`, 'utf-8'))
  const xml = expandRepeats(stripForcedBreaks(readScore(id)))
  const timeline = parseMusicXml(xml)

  it('manifest 必填字段齐全且取值合法', () => {
    expect(manifest.id).toBe(id)
    for (const key of [
      'title', 'composer', 'durationLabel', 'keyLabel', 'description', 'tags',
      'scoreUrl', 'beatsUrl', 'accompanimentUrl', 'accent', 'backgroundTheme', 'bpm',
    ] as const) {
      expect(manifest[key], `manifest.${key}`).toBeTruthy()
    }
    expect([1, 2, 3]).toContain(manifest.difficulty)
    expect(['lumiere', 'aurora', 'ember']).toContain(manifest.backgroundTheme)
    expect(manifest.bpm).toBeGreaterThan(0)
    // 登记约定：accent 与首发曲 teal 不撞（撞色会让曲库页无法区分）
    expect(manifest.accent.toLowerCase()).not.toBe('#5fb8a8')
  })

  it('beats.json：songId 一致，beatAnchors q/t 严格单调递增且 ≥2 项', () => {
    expect(beats.songId).toBe(id)
    const ba = beats.beatAnchors ?? []
    expect(ba.length).toBeGreaterThanOrEqual(2)
    const qs = ba.map((b) => b.q)
    const ts = ba.map((b) => b.t)
    expect([...qs].sort((a, b) => a - b)).toEqual(qs)
    expect(new Set(qs).size).toBe(qs.length)
    expect([...ts].sort((a, b) => a - b)).toEqual(ts)
    expect(new Set(ts).size).toBe(ts.length)
  })

  it('anchors 覆盖谱面全部小节且时间不减', () => {
    const played = timeline.measureTimes
      .filter((m) => !m.end)
      .map((m) => m.measure)
    const anchored = beats.anchors.map((a) => a.m)
    expect([...new Set(anchored)].sort((a, b) => a - b)).toEqual(played)
    const at = beats.anchors.map((a) => a.t)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // 末锚点须伸进伴奏尾部（end 字段覆盖最后一个音乐时刻）
    expect(beats.end).toBeGreaterThan(at[at.length - 1] - 1)
  })

  it('score.musicxml 可被 parseMusicXml 解析出完整时间轴', () => {
    expect(timeline.measureTimes.length).toBeGreaterThanOrEqual(2)
    expect(timeline.notes.length).toBeGreaterThan(0)
    expect(timeline.durationSec).toBeGreaterThan(0)
  })
})
