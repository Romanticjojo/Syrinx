import { readFileSync } from 'node:fs'
const xml = readFileSync('public/songs/luv-letter/score.musicxml', 'utf-8')
const counts = {
  voice2: (xml.match(/<voice>2<\/voice>/g) || []).length,
  voice3: (xml.match(/<voice>3<\/voice>/g) || []).length,
  backup: (xml.match(/<backup/g) || []).length,
  forward: (xml.match(/<forward/g) || []).length,
  repeat: (xml.match(/<repeat/g) || []).length,
  chord: (xml.match(/<chord/g) || []).length,
  measures: (xml.match(/<measure number="/g) || []).length,
  notes: (xml.match(/<note>/g) || []).length,
}
console.log(JSON.stringify(counts))
