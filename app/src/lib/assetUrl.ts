export interface AssetUrlOptions {
  baseUrl: string
  origin: string
  audioFormat?: string
}

/** Resolve manifest root paths against Vite's deployed base directory. */
export function resolveAssetUrl(path: string, options: AssetUrlOptions): string {
  if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.startsWith('//') || !path.startsWith('/')) {
    return path
  }

  const releasePath = options.audioFormat === 'm4a'
    ? path.replace(
        /^(\/songs\/[^/]+\/accompaniment)\.mp3(?=([?#]|$))/,
        '$1.m4a',
      )
    : path
  const base = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`
  return new URL(`${base}${releasePath.slice(1)}`, `${options.origin}/`).toString()
}

/** Resolve an asset using the base and media format embedded by Vite. */
export function assetUrl(path: string): string {
  return resolveAssetUrl(path, {
    baseUrl: import.meta.env.BASE_URL,
    origin: window.location.origin,
    audioFormat: import.meta.env.VITE_AUDIO_FORMAT,
  })
}
