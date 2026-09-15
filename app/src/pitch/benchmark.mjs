// Manual comparison only; no wall-clock assertions in CI.
// Run with Node 24+ from app: node src/pitch/benchmark.mjs
import { registerHooks } from 'node:module'
import { performance } from 'node:perf_hooks'

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context) } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
      return nextResolve(`${specifier}.ts`, context)
    }
  },
})
const { extractPitchTrack, extractPitchTrackAsync, scoreAgainst } = await import('./compare.ts')
const sr = 44100
const pitches = [60, 67, 72, 79, 84, 69]
function fixture(seconds) {
  const data = new Float32Array(seconds * sr)
  let phase = 0
  let seed = 42
  for (let i = 0; i < data.length; i++) {
    const t = i / sr
    const midi = pitches[Math.floor(t / 0.5) % pitches.length]
    const hz = 440 * 2 ** ((midi - 69) / 12)
    phase += 2 * Math.PI * hz * (1 + 0.003 * Math.sin(2 * Math.PI * 5 * t)) / sr
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const envelope = Math.min((t % 0.5) / 0.02, (0.5 - t % 0.5) / 0.02, 1)
    data[i] = envelope * (0.45 * Math.sin(phase) + 0.12 * Math.sin(2 * phase) + 0.04 * Math.sin(3 * phase)) + 0.004 * (seed / 2 ** 32 - 0.5)
  }
  return {
    buffer: { sampleRate: sr, getChannelData: () => data },
    timeline: { durationSec: seconds, tempo: 120, secPerQuarter: 0.5, measureTimes: [],
      notes: Array.from({ length: seconds * 2 }, (_, i) => ({ time: i * 0.5, duration: 0.5, midi: pitches[i % pitches.length], measure: Math.floor(i / 4) + 1 })),
    },
  }
}
extractPitchTrack(fixture(1).buffer)
for (const seconds of [30, 60]) {
  const { buffer, timeline } = fixture(seconds)
  const started = performance.now()
  const syncTrack = extractPitchTrack(buffer)
  const syncMs = performance.now() - started
  const asyncStarted = performance.now()
  const track = await extractPitchTrackAsync(buffer)
  const asyncMs = performance.now() - asyncStarted
  const scoreStarted = performance.now()
  const score = scoreAgainst(track, timeline)
  const scoreMs = performance.now() - scoreStarted
  let activity = 0
  const chartStarted = performance.now()
  for (let pass = 0; pass < 2; pass++) {
    for (const point of track) {
      if (score.notes.some(n => point.time >= n.note.time && point.time < n.note.time + n.note.duration)) activity++
    }
  }
  const chartLookupMs = performance.now() - chartStarted
  console.log(JSON.stringify({ seconds, syncMs: +syncMs.toFixed(2), asyncMs: +asyncMs.toFixed(2), scoreMs: +scoreMs.toFixed(2), chartLookupMs: +chartLookupMs.toFixed(2), points: track.length, exactConsistency: JSON.stringify(track) === JSON.stringify(syncTrack), avgAbsCents: +score.stats.avgAbsCents.toFixed(3), activity }))
}
