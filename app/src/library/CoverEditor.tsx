import { useEffect, useRef, useState } from 'react'
import { readCoverFile } from './cover'
import { errorMessage } from './library-utils'
import './CoverEditor.css'

export default function CoverEditor({ value, title, disabled = false, onChange, onBusyChange }: {
  value: string | null
  title: string
  disabled?: boolean
  onChange: (value: string | null) => void
  onBusyChange: (busy: boolean) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const operation = useRef<AbortController | null>(null)
  const mounted = useRef(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; operation.current?.abort(); operation.current = null }
  }, [])
  const cancel = () => {
    operation.current?.abort(); operation.current = null
    setBusy(false); onBusyChange(false)
  }
  const select = async (file: File) => {
    operation.current?.abort()
    const controller = new AbortController()
    operation.current = controller
    setBusy(true); onBusyChange(true); setError('')
    try {
      const cover = await readCoverFile(file, controller.signal)
      if (mounted.current && operation.current === controller) onChange(cover)
    } catch (e) {
      if (mounted.current && operation.current === controller && !(e instanceof Error && e.name === 'AbortError')) setError(errorMessage(e))
    } finally {
      if (mounted.current && operation.current === controller) { operation.current = null; setBusy(false); onBusyChange(false) }
    }
  }
  const image = value && /^data:image\/(?:png|jpeg|webp);base64,/.test(value) ? value : null
  return <section className="cover-editor" aria-label="乐谱封面">
    <div className="cover-editor-main">
      <div className={`cover-editor-preview${image ? ' has-image' : ''}`}>
        {image ? <img src={image} alt="自定义乐谱封面预览" /> : <><span>SYRINX</span><strong>{title.trim() || '你的乐谱'}</strong><div className="cover-editor-lines" aria-hidden="true"><i /><i /><i /><i /><i /></div></>}
      </div>
      <div className="cover-editor-controls"><h3>乐谱封面</h3><p>为这段旋律，挑一张喜欢的画面。</p>
        <input ref={input} type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" className="library-file-input" aria-label="选择乐谱封面图片" disabled={disabled} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void select(file) }} />
        <div className="cover-editor-actions"><button type="button" className="btn-pill" disabled={disabled} onClick={() => input.current?.click()}>{image ? '更换图片' : '选择图片'}</button>
          {busy ? <button type="button" className="cover-editor-remove" onClick={cancel}>取消处理</button> : image && <button type="button" className="cover-editor-remove" disabled={disabled} onClick={() => { setError(''); onChange(null) }}>移除封面</button>}
        </div>
        <p className="cover-editor-hint">PNG / JPEG / WebP · 最大 10 MiB<br />图片会在本机缩小保存，不会上传。</p>
        {busy && <div className="cover-editor-status" role="status">正在处理封面…</div>}
      </div>
    </div>
    {!!error && <div className="library-error" role="alert">{error}</div>}
  </section>
}
