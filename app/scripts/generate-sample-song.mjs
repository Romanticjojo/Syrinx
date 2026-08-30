// Generate sample Song Pack: score.musicxml (nocturne-style melody) + sample-score in repo.
// Usage: node scripts/generate-sample-song.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const PITCHES = ['A4','C5','E5','B4','G4','A4','E4','A4','C5','B4','A4','G4','E4','D4','E4','A4'];
const NOTE_MAP = { A4:['A',0,4], B4:['B',0,4], C5:['C',0,5], D4:['D',0,4], E4:['E',0,4], E5:['E',0,5], G4:['G',0,4] };

const measures = [];
for (let m = 1; m <= 16; m++) {
  if ([4, 8, 12, 16].includes(m)) {
    measures.push([
      { type: 'half', dots: 0, div: 32, p: PITCHES[m - 1] },
      { type: 'quarter', dots: 0, div: 16, p: PITCHES[m % 16] },
    ]);
  } else if ([2, 6, 10, 14].includes(m)) {
    measures.push([
      { type: 'quarter', dots: 0, div: 16, p: PITCHES[m - 1] },
      { type: 'quarter', dots: 0, div: 16, p: PITCHES[(m + 3) % 16] },
      { type: 'quarter', dots: 0, div: 16, p: PITCHES[(m + 7) % 16] },
    ]);
  } else {
    measures.push([{ type: 'half', dots: 1, div: 48, p: PITCHES[m - 1] }]);
  }
}

function noteXml({ type, dots, div, p }) {
  const [step, alter, octave] = NOTE_MAP[p];
  const pitch = `<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>`;
  return `        <note>${pitch}<duration>${div}</duration><voice>1</voice><type>${type}</type>${'<dot/>'.repeat(dots)}</note>`;
}

let xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <work><work-title>Lumiere (sample study)</work-title></work>
  <part-list>
    <score-part id="P1"><part-name>Flute</part-name></score-part>
  </part-list>
  <part id="P1">
`;
measures.forEach((notes, i) => {
  xml += `      <measure number="${i + 1}">\n`;
  if (i === 0) {
    xml += `        <attributes><divisions>16</divisions><key><fifths>0</fifths></key><time><beats>3</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>\n`;
    xml += `        <direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>84</per-minute></metronome></direction-type><sound tempo="84"/></direction>\n`;
  }
  xml += notes.map(noteXml).join('\n') + '\n';
  xml += `      </measure>\n`;
});
xml += `    </part>\n</score-partwise>\n`;

const out = new URL('../public/songs/lumiere/score.musicxml', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, xml, 'utf-8');
console.log('wrote', out, xml.length, 'bytes');
