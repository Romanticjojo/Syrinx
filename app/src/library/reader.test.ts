import { describe, expect, it, vi } from 'vitest'
import { createScorePaginator } from './reader'

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <work><work-title>分页测试</work-title></work>
  <identification><creator type="composer">测试作者</creator></identification>
  <part-list>
    <score-part id="P1"><part-name>长笛</part-name></score-part>
    <score-part id="P2"><part-name>钢琴</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <print new-system="yes"/>
      <attributes>
        <divisions>2</divisions>
        <key><fifths>1</fifths></key>
        <time><beats>3</beats><beat-type>4</beat-type></time>
        <staves>2</staves>
        <clef number="1"><sign>G</sign><line>2</line></clef>
        <clef number="2"><sign>F</sign><line>4</line></clef>
        <transpose number="1"><chromatic>2</chromatic></transpose>
        <staff-details number="1"><staff-lines>5</staff-lines></staff-details>
      </attributes>
      <barline location="left"><repeat direction="forward"/></barline>
    </measure>
    <measure number="2">
      <attributes><key><fifths>-1</fifths></key></attributes>
    </measure>
    <measure number="3">
      <print new-page="yes" new-system="yes"><system-layout/></print>
      <attributes>
        <key><fifths>4</fifths></key>
      </attributes>
      <attributes><clef number="2"><sign>C</sign><line>3</line></clef></attributes>
      <note><rest/><duration>2</duration><voice>1</voice><staff>2</staff></note>
    </measure>
    <measure number="4">
      <barline location="right"><repeat direction="backward" times="2"/></barline>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes>
        <divisions>4</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>F</sign><line>4</line></clef>
      </attributes>
    </measure>
    <measure number="2"/>
    <measure number="3"/>
    <measure number="4"/>
  </part>
</score-partwise>`

function parse(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'application/xml')
}

function part(doc: Document, id: string): Element {
  const found = [...doc.querySelectorAll('part')].find((item) => item.getAttribute('id') === id)
  if (!found) throw new Error(`missing part ${id}`)
  return found
}

function directChildren(element: Element, name: string): Element[] {
  return [...element.children].filter((child) => child.localName === name)
}

describe('MusicXML 阅谱分页', () => {
  it('解析一次并按相同小节位置切出所有声部', () => {
    const parseSpy = vi.spyOn(DOMParser.prototype, 'parseFromString')
    const paginator = createScorePaginator(XML, 2)
    const first = paginator.page(0)
    const second = paginator.page(1)

    expect(paginator.totalMeasures).toBe(4)
    expect(paginator.pageCount).toBe(2)
    expect(parseSpy).toHaveBeenCalledTimes(1)
    parseSpy.mockRestore()

    const firstDoc = parse(first)
    const secondDoc = parse(second)
    expect(firstDoc.querySelector('work-title')?.textContent).toBe('分页测试')
    expect(firstDoc.querySelectorAll('part-list > score-part')).toHaveLength(2)
    expect(directChildren(part(firstDoc, 'P1'), 'measure').map((m) => m.getAttribute('number'))).toEqual(['1', '2'])
    expect(directChildren(part(firstDoc, 'P2'), 'measure').map((m) => m.getAttribute('number'))).toEqual(['1', '2'])
    expect(directChildren(part(secondDoc, 'P1'), 'measure').map((m) => m.getAttribute('number'))).toEqual(['3', '4'])
    expect(directChildren(part(secondDoc, 'P2'), 'measure').map((m) => m.getAttribute('number'))).toEqual(['3', '4'])
    expect(secondDoc.querySelector('measure[number="4"] repeat[direction="backward"]')?.getAttribute('times')).toBe('2')
  })

  it('第二页首小节补齐继承属性，由当前小节覆盖同作用域状态', () => {
    const doc = parse(createScorePaginator(XML, 2).page(1))
    const p1Start = directChildren(part(doc, 'P1'), 'measure')[0]
    const p2Start = directChildren(part(doc, 'P2'), 'measure')[0]
    const p1Attributes = directChildren(p1Start, 'attributes')

    expect(p1Attributes).toHaveLength(1)
    expect(p1Attributes[0].querySelector('staves')?.textContent).toBe('2')
    expect(p1Start.querySelectorAll('divisions')).toHaveLength(1)
    expect(p1Start.querySelector('divisions')?.textContent).toBe('2')
    expect(p1Start.querySelectorAll('key')).toHaveLength(1)
    expect(p1Start.querySelector('key > fifths')?.textContent).toBe('4')
    expect(p1Start.querySelector('time > beats')?.textContent).toBe('3')
    expect(p1Start.querySelectorAll('clef[number="1"]')).toHaveLength(1)
    expect(p1Start.querySelector('clef[number="1"] > sign')?.textContent).toBe('G')
    expect(p1Start.querySelectorAll('clef[number="2"]')).toHaveLength(1)
    expect(p1Start.querySelector('clef[number="2"] > sign')?.textContent).toBe('C')
    expect(p1Start.querySelector('transpose[number="1"] > chromatic')?.textContent).toBe('2')
    expect(p1Start.querySelector('staff-details[number="1"] > staff-lines')?.textContent).toBe('5')
    expect(p1Start.querySelector('note > staff')?.textContent).toBe('2')

    expect(p2Start.querySelector('divisions')?.textContent).toBe('4')
    expect(p2Start.querySelector('key > fifths')?.textContent).toBe('0')
    expect(p2Start.querySelector('time > beats')?.textContent).toBe('4')
    expect(p2Start.querySelector('clef > sign')?.textContent).toBe('F')
  })

  it('按最长声部分页，并从后续页面移除已经结束的声部及其 part-list 定义', () => {
    const uneven = `<score-partwise><part-list>
      <score-part id="P1"><part-name>四小节</part-name></score-part>
      <score-part id="P2"><part-name>两小节</part-name></score-part>
      <score-part id="P3"><part-name>三小节</part-name></score-part>
    </part-list>
    <part id="P1"><measure number="1"/><measure number="2"/><measure number="3"/><measure number="4"/></part>
    <part id="P2"><measure number="1"/><measure number="2"/></part>
    <part id="P3"><measure number="1"/><measure number="2"/><measure number="3"/></part>
    </score-partwise>`

    const paginator = createScorePaginator(uneven, 2)
    const first = parse(paginator.page(0))
    const second = parse(paginator.page(1))

    expect(paginator.totalMeasures).toBe(4)
    expect(paginator.pageCount).toBe(2)
    expect([...first.querySelectorAll('part-list > score-part')].map((item) => item.getAttribute('id'))).toEqual(['P1', 'P2', 'P3'])
    expect([...first.querySelectorAll('score-partwise > part')].map((item) => item.getAttribute('id'))).toEqual(['P1', 'P2', 'P3'])
    expect([...second.querySelectorAll('part-list > score-part')].map((item) => item.getAttribute('id'))).toEqual(['P1', 'P3'])
    expect([...second.querySelectorAll('score-partwise > part')].map((item) => item.getAttribute('id'))).toEqual(['P1', 'P3'])
    expect(directChildren(part(second, 'P1'), 'measure').map((item) => item.getAttribute('number'))).toEqual(['3', '4'])
    expect(directChildren(part(second, 'P3'), 'measure').map((item) => item.getAttribute('number'))).toEqual(['3'])
  })

  it('页首无编号属性覆盖此前所有 staff 的同类编号属性', () => {
    const scoped = `<score-partwise><part-list><score-part id="P1"><part-name>P1</part-name></score-part></part-list><part id="P1">
      <measure number="1"><attributes>
        <key number="1"><fifths>1</fifths></key>
        <key number="2"><fifths>-2</fifths></key>
      </attributes></measure>
      <measure number="2"><attributes><key><fifths>0</fifths></key></attributes></measure>
    </part></score-partwise>`

    const second = parse(createScorePaginator(scoped, 1).page(1))

    expect(second.querySelectorAll('measure > attributes > key')).toHaveLength(1)
    expect(second.querySelector('key')?.getAttribute('number')).toBeNull()
    expect(second.querySelector('key > fifths')?.textContent).toBe('0')
  })

  it('移除分页输出中的强制换页和换行属性，保留其他 print 内容', () => {
    const first = parse(createScorePaginator(XML, 2).page(0))
    const second = parse(createScorePaginator(XML, 2).page(1))

    expect(first.querySelector('[new-page], [new-system]')).toBeNull()
    expect(second.querySelector('[new-page], [new-system]')).toBeNull()
    expect(second.querySelector('print > system-layout')).not.toBeNull()
  })

  it('反复按页调用不会消耗或改写已解析的源谱', () => {
    const paginator = createScorePaginator(XML, 2)
    const secondBefore = paginator.page(1)

    paginator.page(0)
    const secondAfter = paginator.page(1)

    expect(secondAfter).toBe(secondBefore)
    expect(parse(secondAfter).querySelector('measure[number="4"] repeat')).not.toBeNull()
  })

  it.each([
    ['', /为空/],
    ['<score-partwise><part></score-partwise>', /格式/],
    ['<score-timewise/>', /score-partwise/],
    ['<!DOCTYPE score-partwise [<!ENTITY x "bad">]><score-partwise>&x;</score-partwise>', /实体|DOCTYPE/],
  ])('拒绝无效或不安全 XML', (xml, message) => {
    expect(() => createScorePaginator(xml)).toThrow(message)
  })

  it.each([0, -1, 1.5, Number.NaN, 65])('拒绝无效每页小节数 %s', (size) => {
    expect(() => createScorePaginator(XML, size)).toThrow(/每页/)
  })

  it.each([-1, 2, 1.5, Number.NaN])('拒绝越界或无效页码 %s', (index) => {
    const paginator = createScorePaginator(XML, 2)
    expect(() => paginator.page(index)).toThrow(/页码/)
  })
})
