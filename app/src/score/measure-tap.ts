/** A tap may select; native pan, wheel and pinch gestures keep their browser behavior. */
export function bindMeasureTap(host: HTMLElement, select: (x: number, y: number) => void): () => void {
  const doc = host.ownerDocument
  const pointers = new Set<number>()
  let tap: { id: number; x: number; y: number; started: number } | null = null
  const cancel = () => { tap = null }
  const down = (event: PointerEvent) => {
    const inside = event.target instanceof Node && host.contains(event.target)
    if (!inside && !pointers.size) return
    pointers.add(event.pointerId)
    if (pointers.size !== 1 || event.button !== 0 || !inside) { cancel(); return }
    tap = { id: event.pointerId, x: event.clientX, y: event.clientY, started: performance.now() }
  }
  const move = (event: PointerEvent) => {
    if (tap?.id === event.pointerId && Math.hypot(event.clientX - tap.x, event.clientY - tap.y) > 8) cancel()
  }
  const up = (event: PointerEvent) => {
    const current = tap
    pointers.delete(event.pointerId)
    cancel()
    if (current?.id !== event.pointerId || event.button !== 0 || pointers.size ||
      performance.now() - current.started > 600 ||
      Math.hypot(event.clientX - current.x, event.clientY - current.y) > 8 ||
      !(event.target instanceof Node) || !host.contains(event.target)) return
    select(event.clientX, event.clientY)
  }
  const pointerCancel = (event: PointerEvent) => { pointers.delete(event.pointerId); cancel() }
  const blur = () => { pointers.clear(); cancel() }
  doc.addEventListener('pointerdown', down, true)
  doc.addEventListener('pointermove', move, true)
  doc.addEventListener('pointerup', up, true)
  doc.addEventListener('pointercancel', pointerCancel, true)
  // Capture catches non-bubbling scroll events, including scrolling ancestors.
  doc.addEventListener('scroll', cancel, true)
  doc.addEventListener('wheel', cancel, { capture: true, passive: true })
  doc.defaultView?.addEventListener('blur', blur)
  return () => {
    doc.removeEventListener('pointerdown', down, true)
    doc.removeEventListener('pointermove', move, true)
    doc.removeEventListener('pointerup', up, true)
    doc.removeEventListener('pointercancel', pointerCancel, true)
    doc.removeEventListener('scroll', cancel, true)
    doc.removeEventListener('wheel', cancel, true)
    doc.defaultView?.removeEventListener('blur', blur)
  }
}
