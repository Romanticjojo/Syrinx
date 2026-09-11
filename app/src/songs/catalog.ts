import type { SongManifest } from '../types'

export const PRIVATE_SONG_ORDER = [
  'luv-letter',
  'flower-dance',
  'river-flows-in-you',
  'expedition-33',
  'alicia',
  'birds-poem',
  'interstellar',
] as const

type ManifestModule = { default?: unknown } | unknown

// These old placeholder packs remain on disk only as parser test fixtures.
const RETIRED_FIXTURE_IDS = new Set(['lumiere', 'aurora-scale'])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export function isSongManifest(value: unknown): value is SongManifest {
  if (!isRecord(value)) return false
  const strings = ['id', 'title', 'composer', 'durationLabel', 'keyLabel', 'description', 'scoreUrl', 'accent']
  if (!strings.every((key) => typeof value[key] === 'string' && value[key].length > 0)) return false
  if (![1, 2, 3].includes(value.difficulty as number)) return false
  if (!['lumiere', 'aurora', 'ember'].includes(value.backgroundTheme as string)) return false
  if (typeof value.bpm !== 'number' || !Number.isFinite(value.bpm) || value.bpm <= 0) return false
  return Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === 'string')
}

const unwrapManifest = (module: ManifestModule): unknown =>
  isRecord(module) && 'default' in module ? module.default : module

function privateSongs(modules: Record<string, ManifestModule>): SongManifest[] {
  const byId = new Map<string, SongManifest>()
  for (const [path, module] of Object.entries(modules)) {
    const manifest = unwrapManifest(module)
    if (!isSongManifest(manifest)) continue
    if (RETIRED_FIXTURE_IDS.has(manifest.id)) continue
    const pathId = /\/songs\/([^/]+)\/manifest\.json$/.exec(path.replaceAll('\\', '/'))?.[1]
    if (pathId && pathId !== manifest.id) continue
    if (!byId.has(manifest.id)) byId.set(manifest.id, manifest)
  }

  const rank = new Map<string, number>(PRIVATE_SONG_ORDER.map((id, index) => [id, index]))
  return [...byId.values()].sort((a, b) => {
    const aRank = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER
    const bRank = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER
    return aRank - bRank || a.id.localeCompare(b.id)
  })
}

/** Build a usable catalog from optional private packs and the checked-in sample. */
export function buildSongCatalog(
  modules: Record<string, ManifestModule>,
  sample: unknown,
  allowlist: string | undefined,
): SongManifest[] {
  const available = privateSongs(modules)
  const demo = isSongManifest(sample) ? sample : undefined

  if (allowlist !== undefined) {
    const candidates = new Map(available.map((manifest) => [manifest.id, manifest]))
    if (demo) candidates.set(demo.id, demo)
    const ids = [...new Set(allowlist.split(',').map((id) => id.trim()).filter(Boolean))]
    return ids.flatMap((id) => {
      const manifest = candidates.get(id)
      return manifest ? [manifest] : []
    })
  }

  return available.length > 0 ? available : demo ? [demo] : []
}
