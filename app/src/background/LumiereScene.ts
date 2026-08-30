import * as THREE from 'three'

/**
 * 每曲主题动态背景（three.js）：
 * - 深色渐变夜空（大球体内表面）
 * - 主题色光尘粒子（缓慢上升 + sin 漂移 + 呼吸）
 * - 地平线光晕（径向渐变 CanvasTexture，additive）
 * - audio-reactive：低频能量驱动光晕强度与粒子亮度（不动位置，保谱面稳定可读）
 * 场景置于谱面层之下（CSS z-index），谱面容器自带近黑面板双保险。
 */
export class LumiereScene {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private points: THREE.Points
  private glowMat: THREE.MeshBasicMaterial
  private dustMat: THREE.PointsMaterial
  private baseDustOpacity: number
  private baseGlowOpacity: number
  private raf = 0
  private disposed = false
  private reducedMotion: boolean
  private freqData: Uint8Array<ArrayBuffer> | null = null
  private clock = new THREE.Clock()

  constructor(canvas: HTMLCanvasElement, accent = '#3ddfae') {
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight, false)

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(
      55,
      canvas.clientWidth / Math.max(canvas.clientHeight, 1),
      0.1,
      100,
    )
    this.camera.position.set(0, 1.2, 7)

    // 主题色 → three 颜色
    const accentColor = new THREE.Color(accent)
    const dustColor = accentColor.clone().lerp(new THREE.Color('#ffe9b8'), 0.45) // 光尘偏暖金

    // 夜空渐变球（内表面 vertex-y 渐变：深空 → 地平线微光）
    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        uTop: { value: new THREE.Color('#05070c') },
        uBottom: { value: accentColor.clone().multiplyScalar(0.12) },
      },
      vertexShader: /* glsl */ `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop;
        uniform vec3 uBottom;
        varying vec3 vPos;
        void main() {
          float h = clamp((vPos.y + 20.0) / 40.0, 0.0, 1.0);
          vec3 c = mix(uBottom, uTop, pow(h, 0.7));
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    })
    const sky = new THREE.Mesh(new THREE.SphereGeometry(40, 32, 24), skyMat)
    this.scene.add(sky)

    // 光尘粒子：xz 环绕分布，缓慢上升
    const COUNT = this.reducedMotion ? 0 : 1500
    const geo = new THREE.BufferGeometry()
    const pos = new Float32Array(Math.max(COUNT, 1) * 3)
    const seeds = new Float32Array(Math.max(COUNT, 1))
    for (let i = 0; i < COUNT; i++) {
      const r = 2 + Math.random() * 14
      const a = Math.random() * Math.PI * 2
      pos[i * 3] = Math.cos(a) * r
      pos[i * 3 + 1] = Math.random() * 16 - 6
      pos[i * 3 + 2] = Math.sin(a) * r
      seeds[i] = Math.random() * Math.PI * 2
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.dustMat = new THREE.PointsMaterial({
      color: dustColor,
      size: 0.06,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true,
    })
    this.points = new THREE.Points(geo, this.dustMat)
    if (COUNT > 0) this.scene.add(this.points)

    // 地平线光晕：径向渐变 CanvasTexture
    this.glowMat = new THREE.MeshBasicMaterial({
      map: makeRadialTexture(accentColor),
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(60, 18), this.glowMat)
    glow.position.set(0, -2.5, -18)
    this.scene.add(glow)

    this.baseDustOpacity = this.dustMat.opacity
    this.baseGlowOpacity = this.glowMat.opacity

    this.loop()
  }

  /** 由演奏页每帧喂频谱（audioEngine.analyser）；不传则静态呼吸 */
  setAnalyser(analyser: AnalyserNode | null): void {
    if (!analyser) {
      this.freqData = null
      return
    }
    this.freqData = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount))
    this.analyserRef = analyser
  }
  private analyserRef: AnalyserNode | null = null

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / Math.max(h, 1)
    this.camera.updateProjectionMatrix()
  }

  private loop = (): void => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    const dt = this.clock.getElapsedTime()

    // 低频能量（0-8 bin）→ 0..1
    let energy = 0
    if (this.analyserRef && this.freqData) {
      this.analyserRef.getByteFrequencyData(this.freqData)
      let sum = 0
      const bins = Math.min(8, this.freqData.length)
      for (let i = 0; i < bins; i++) sum += this.freqData[i]
      energy = Math.min(1, sum / bins / 180)
    }

    // 光晕与粒子亮度随音频呼吸（位置不动，谱面区域稳定）
    this.glowMat.opacity = this.baseGlowOpacity * (0.75 + energy * 1.1)
    this.dustMat.opacity = this.baseDustOpacity * (0.8 + energy * 0.9)

    if (!this.reducedMotion && this.points.visible) {
      const pos = this.points.geometry.getAttribute('position') as THREE.BufferAttribute
      const arr = pos.array as Float32Array
      const n = arr.length / 3
      for (let i = 0; i < n; i++) {
        arr[i * 3 + 1] += 0.0035 + energy * 0.002 // 上升
        if (arr[i * 3 + 1] > 10) arr[i * 3 + 1] = -6
        arr[i * 3] += Math.sin(dt * 0.4 + i) * 0.0015 // sin 漂移
      }
      pos.needsUpdate = true
    }

    this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh
      if (mesh.geometry) mesh.geometry.dispose()
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat?.dispose()
    })
    // CanvasTexture 不随 material.dispose 释放，需显式清理
    this.glowMat.map?.dispose()
    this.renderer.dispose()
  }
}

/** 径向渐变贴图（Canvas 2D → THREE.Texture） */
function makeRadialTexture(color: THREE.Color): THREE.Texture {
  const size = 256
  const cv = document.createElement('canvas')
  cv.width = size
  cv.height = size
  const g = cv.getContext('2d')!
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  const rgb = `${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)}`
  grad.addColorStop(0, `rgba(${rgb},0.85)`)
  grad.addColorStop(0.4, `rgba(${rgb},0.25)`)
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(cv)
  tex.needsUpdate = true
  return tex
}
