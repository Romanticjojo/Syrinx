export function releaseBase(releaseId: string | undefined): string {
  if (!releaseId) return '/'
  if (!/^[A-Za-z0-9._-]+$/.test(releaseId)) {
    throw new Error(`Invalid SYRINX_RELEASE_ID: ${releaseId}`)
  }
  return `/releases/${releaseId}/`
}
