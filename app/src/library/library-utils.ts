export function downloadLocal(content: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = Array.from(filename.replace(/[<>:"/\\|?*]/g, '_'), (character) => character.charCodeAt(0) < 32 ? '_' : character).join('').slice(0, 180)
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : '操作没有完成，请重试。'
