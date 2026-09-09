import type { Take } from '../types'

/** A download owns a separate URL, so changing results cannot invalidate it. */
export function downloadPracticeBlob(take: Pick<Take, 'songId' | 'startedAt' | 'sessionId' | 'mimeType'>, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const ext = take.mimeType.includes('wav') ? 'wav' : take.mimeType.includes('mp4') ? 'mp4' : 'webm'
  const stamp = new Date(take.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '')
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `syrinx-${take.songId}-${stamp}-${take.sessionId.slice(-8)}.${ext}`
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
