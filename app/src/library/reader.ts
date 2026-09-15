const MAX_XML_BYTES = 10 * 1024 * 1024
const MAX_PARTS = 32
const MAX_MEASURES = 4_000
const MAX_MEASURES_PER_PAGE = 64
const INHERITED_ATTRIBUTE_NAMES = new Set([
  'divisions',
  'key',
  'time',
  'staves',
  'clef',
  'transpose',
  'staff-details',
])
const ATTRIBUTE_ORDER = new Map([
  ['divisions', 0],
  ['key', 1],
  ['time', 2],
  ['staves', 3],
  ['part-symbol', 4],
  ['instruments', 5],
  ['clef', 6],
  ['staff-details', 7],
  ['transpose', 8],
  ['directive', 9],
  ['measure-style', 10],
])

export interface ScorePaginator {
  totalMeasures: number
  pageCount: number
  page(index: number): string
}

interface PartInfo {
  source: Element
  measures: Element[]
  inheritedAtPage: Map<string, Element>[]
}

function fail(message: string): never {
  throw new Error(message)
}

function directChildren(element: Element, localName: string): Element[] {
  return [...element.children].filter((child) => child.localName === localName)
}

function attributeKey(element: Element): string {
  if (element.localName === 'divisions') return 'divisions:*'
  const number = element.getAttribute('number')
  if (number !== null) return `${element.localName}:${number}`
  if (element.localName === 'clef' || element.localName === 'staff-details') {
    return `${element.localName}:1`
  }
  return `${element.localName}:*`
}

function isGlobalAttribute(element: Element): boolean {
  return element.getAttribute('number') === null
    && element.localName !== 'clef'
    && element.localName !== 'staff-details'
}

function removeAttributeFamily(state: Map<string, Element>, localName: string): void {
  for (const key of state.keys()) {
    if (key.startsWith(`${localName}:`)) state.delete(key)
  }
}

function updateInherited(state: Map<string, Element>, measure: Element): void {
  for (const attributes of directChildren(measure, 'attributes')) {
    for (const child of [...attributes.children]) {
      if (INHERITED_ATTRIBUTE_NAMES.has(child.localName)) {
        if (isGlobalAttribute(child)) removeAttributeFamily(state, child.localName)
        state.set(attributeKey(child), child)
      }
    }
  }
}

function inheritedSnapshots(measures: Element[], measuresPerPage: number): Map<string, Element>[] {
  const snapshots: Map<string, Element>[] = []
  const state = new Map<string, Element>()
  for (let index = 0; index < measures.length; index += 1) {
    if (index % measuresPerPage === 0) snapshots[index / measuresPerPage] = new Map(state)
    updateInherited(state, measures[index])
  }
  return snapshots
}

function pageStartAttributes(measure: Element): Element[] {
  const result: Element[] = []
  for (const child of [...measure.children]) {
    if (child.localName === 'note' || child.localName === 'backup' || child.localName === 'forward') break
    if (child.localName === 'attributes') result.push(child)
  }
  return result
}

function sortAttributes(attributes: Element): void {
  const sorted = [...attributes.children]
    .sort((left, right) => {
      const byName = (ATTRIBUTE_ORDER.get(left.localName) ?? 99) - (ATTRIBUTE_ORDER.get(right.localName) ?? 99)
      if (byName !== 0) return byName
      return (left.getAttribute('number') ?? '').localeCompare(right.getAttribute('number') ?? '', undefined, { numeric: true })
    })
  for (const element of sorted) attributes.appendChild(element)
}

function mergePageStartAttributes(measure: Element, inherited: Map<string, Element>): void {
  const blocks = pageStartAttributes(measure)
  if (inherited.size === 0 && blocks.length <= 1) return

  const effective = new Map(inherited)
  for (const attributes of blocks) {
    for (const child of [...attributes.children]) {
      if (INHERITED_ATTRIBUTE_NAMES.has(child.localName)) {
        if (isGlobalAttribute(child)) removeAttributeFamily(effective, child.localName)
        effective.set(attributeKey(child), child)
      }
    }
  }
  if (effective.size === 0) return

  const first = blocks[0] ?? measure.ownerDocument.createElementNS(measure.namespaceURI, 'attributes')
  if (blocks.length === 0) measure.insertBefore(first, measure.firstChild)
  for (const attributes of blocks) {
    for (const child of [...attributes.children]) {
      if (INHERITED_ATTRIBUTE_NAMES.has(child.localName)) child.remove()
    }
  }
  for (const attributes of blocks.slice(1)) {
    if (attributes.children.length === 0) attributes.remove()
  }
  for (const element of effective.values()) first.appendChild(element.cloneNode(true))
  sortAttributes(first)
}

function keepPartDefinitions(root: Element, includedIds: Set<string>): void {
  const partList = directChildren(root, 'part-list')[0]
  if (!partList) return
  for (const definition of directChildren(partList, 'score-part')) {
    if (!includedIds.has(definition.getAttribute('id') ?? '')) definition.remove()
  }
}

function removeForcedBreaks(root: Element): void {
  for (const print of [...root.querySelectorAll('print')]) {
    print.removeAttribute('new-page')
    print.removeAttribute('new-system')
  }
}

function parseSource(xml: string): Document {
  if (typeof xml !== 'string' || xml.length === 0) fail('MusicXML 不能为空。')
  if (xml.length > MAX_XML_BYTES || new TextEncoder().encode(xml).byteLength > MAX_XML_BYTES) {
    fail('MusicXML 不能超过 10 MiB。')
  }
  if (/<!ENTITY\b/i.test(xml) || /<!DOCTYPE[^>]*\[/i.test(xml)) {
    fail('不支持包含实体或内部子集的 DOCTYPE。')
  }
  const clean = xml.replace(/<!DOCTYPE\s+[\s\S]*?>/gi, '')
  const document = new DOMParser().parseFromString(clean, 'application/xml')
  if (document.querySelector('parsererror') || document.documentElement.localName !== 'score-partwise') {
    fail(document.documentElement.localName === 'score-partwise'
      ? 'MusicXML 格式无效。'
      : '仅支持 score-partwise MusicXML。')
  }
  return document
}

export function createScorePaginator(xml: string, measuresPerPage = 16): ScorePaginator {
  if (!Number.isInteger(measuresPerPage) || measuresPerPage < 1 || measuresPerPage > MAX_MEASURES_PER_PAGE) {
    fail(`每页小节数必须是 1 到 ${MAX_MEASURES_PER_PAGE} 的整数。`)
  }

  const document = parseSource(xml)
  const root = document.documentElement
  const partElements = directChildren(root, 'part')
  if (partElements.length === 0 || partElements.length > MAX_PARTS) {
    fail(`乐谱声部数量必须是 1 到 ${MAX_PARTS}。`)
  }

  const partMeasures = partElements.map((part) => directChildren(part, 'measure'))
  if (partMeasures.some((measures) => measures.length === 0 || measures.length > MAX_MEASURES)) {
    fail(`乐谱小节数量必须是 1 到 ${MAX_MEASURES}。`)
  }
  const totalMeasures = Math.max(...partMeasures.map((measures) => measures.length))

  const parts: PartInfo[] = partElements.map((source, index) => ({
    source,
    measures: partMeasures[index],
    inheritedAtPage: inheritedSnapshots(partMeasures[index], measuresPerPage),
  }))
  const pageCount = Math.ceil(totalMeasures / measuresPerPage)
  const cache = new Map<number, string>()

  return {
    totalMeasures,
    pageCount,
    page(index) {
      if (!Number.isInteger(index) || index < 0 || index >= pageCount) {
        fail(`页码必须是 0 到 ${pageCount - 1} 的整数。`)
      }
      const cached = cache.get(index)
      if (cached !== undefined) return cached

      const pageRoot = root.cloneNode(false) as Element
      for (const child of [...root.childNodes]) {
        if (child.nodeType === Node.ELEMENT_NODE && (child as Element).localName === 'part') continue
        pageRoot.appendChild(child.cloneNode(true))
      }

      const start = index * measuresPerPage
      const end = Math.min(start + measuresPerPage, totalMeasures)
      const includedIds = new Set<string>()
      for (const part of parts) {
        if (start >= part.measures.length) continue
        includedIds.add(part.source.getAttribute('id') ?? '')
        const pagePart = part.source.cloneNode(false) as Element
        const partEnd = Math.min(end, part.measures.length)
        for (let measureIndex = start; measureIndex < partEnd; measureIndex += 1) {
          const measure = part.measures[measureIndex].cloneNode(true) as Element
          if (measureIndex === start) mergePageStartAttributes(measure, part.inheritedAtPage[index])
          pagePart.appendChild(measure)
        }
        pageRoot.appendChild(pagePart)
      }

      keepPartDefinitions(pageRoot, includedIds)
      removeForcedBreaks(pageRoot)
      const result = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(pageRoot)}`
      cache.set(index, result)
      return result
    },
  }
}
