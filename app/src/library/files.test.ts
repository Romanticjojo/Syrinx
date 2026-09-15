import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { readScoreFile } from './files'
const source = '<score-partwise><part-list><score-part id="P"><part-name>Piano</part-name></score-part></part-list><part id="P"><measure number="1"><note><rest/><duration>4</duration></note></measure></part></score-partwise>'
const file = (body: Uint8Array | string, name: string) => new File([body as BlobPart], name)
const container = (path: string) => strToU8(`<container><rootfiles><rootfile full-path="${path}" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>`)
describe('bounded local MusicXML files', () => {
  it('reads plain XML with a standard external DTD without retrieving it', async () => {
    const xml = '<!DOCTYPE score-partwise SYSTEM "http://www.musicxml.org/dtds/partwise.dtd">' + source
    expect(await readScoreFile(file(xml, 'music.musicxml'))).toBe(xml)
  })
  it('uses META-INF/container.xml rather than the first XML entry', async () => {
    const zip = zipSync({ 'first.xml': strToU8('<irrelevant/>'), 'META-INF/container.xml': container('scores/music.xml'), 'scores/music.xml': strToU8(source) })
    expect(await readScoreFile(file(zip, 'music.mxl'))).toBe(source)
  })
  it('rejects missing containers, unsafe paths, corrupt input and excessive expansion', async () => {
    await expect(readScoreFile(file(zipSync({ 'score.xml': strToU8(source) }), 'bad.mxl'))).rejects.toThrow(/container/)
    await expect(readScoreFile(file(zipSync({ '../score.xml': strToU8(source), 'META-INF/container.xml': container('../score.xml') }), 'bad.mxl'))).rejects.toThrow(/路径/)
    await expect(readScoreFile(file('PK broken', 'bad.mxl'))).rejects.toThrow(/MXL|ZIP/)
    await expect(readScoreFile(file(zipSync({ 'big.xml': new Uint8Array(10 * 1024 * 1024 + 1), 'META-INF/container.xml': container('big.xml') }), 'big.mxl'))).rejects.toThrow(/大小|MiB/)
    await expect(readScoreFile(file('<score-timewise/>', 'bad.xml'))).rejects.toThrow(/score-partwise/)
    await expect(readScoreFile(file('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><score-partwise/>', 'bad.xml'))).rejects.toThrow(/实体|DOCTYPE/)
  })
  it('rejects more than 128 archive entries', async () => {
    const zip = zipSync(Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`${i}.txt`, strToU8('x')])))
    await expect(readScoreFile(file(zip, 'many.mxl'))).rejects.toThrow(/数量/)
  })
})
