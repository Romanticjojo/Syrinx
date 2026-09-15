/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SONG_IDS?: string
  readonly VITE_AUDIO_FORMAT?: 'm4a' | 'mp3'
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
