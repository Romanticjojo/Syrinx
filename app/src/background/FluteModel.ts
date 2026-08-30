import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/**
 * 3D 长笛展示（入场动画 / 预览页 hero 共用）：
 * GLTFLoader 加载 glb → 自动居中缩放 → 缓慢自转 + 微浮动；
 * 加载失败由 React 包装层回退 CSS 长笛条。透明背景合成到页面之上。
 */
export class FluteModel {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private root = new THREE.Group()
  private raf = 0
  private disposed = false
  private reducedMotion: boolean
  private clock = new THREE.Clock()
  private loader: GLTFLoader | null = null

  constructor(canvas: HTMLCanvasElement, accent = '#3ddfae') {
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(canvas.clientWidth || 300, canvas.clientHeight || 160, false)

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(32, 3 / 1.6, 0.1, 50)
    this.camera.position.set(0, 0.4, 7.5)
    this.camera.lookAt(0, 0, 0)
    this.scene.add(this.root)

    // 三点布光：环境 + 主光 + 主题色点光（金属按键反光）
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.1))
    const key = new THREE.DirectionalLight(0xfff2e0, 2.2)
    key.position.set(3, 4, 5)
    this.scene.add(key)
    const rim = new THREE.PointLight(new THREE.Color(accent), 14, 18)
    rim.position.set(-3.5, -1, 3)
    this.scene.add(rim)

    // 占位：加载完成前的极简长笛条（同 CSS fallback 形态，避免闪空）
    const placeholder = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.09, 3.4, 6, 14),
      new THREE.MeshStandardMaterial({ color: 0x9aa4ad, metalness: 0.85, roughness: 0.35 }),
    )
    placeholder.rotation.z = Math.PI / 2.4
    this.root.add(placeholder)

    this.loop()
  }

  /** 加载模型；成功返回 true（失败由调用方回退 CSS） */
  async load(url: string): Promise<boolean> {
    this.loader ??= new GLTFLoader()
    try {
      const gltf = await this.loader.loadAsync(url)
      if (this.disposed) return false

      const model = gltf.scene
      // 自动居中 + 归一化尺寸
      const box = new THREE.Box3().setFromObject(model)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const scale = 4.2 / Math.max(size.x, size.y, size.z, 0.001)
      model.position.sub(center)
      model.scale.setScalar(scale)
      // 长笛横置微倾
      model.rotation.z = -Math.PI / 14

      const holder = new THREE.Group()
      holder.add(model)

      this.root.clear()
      this.root.add(holder)
      return true
    } catch {
      return false
    }
  }

  resize(w: number, h: number): void {
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / Math.max(h, 1)
    this.camera.updateProjectionMatrix()
  }

  private loop = (): void => {
    if (this.disposed) return
    this.raf = requestAnimationFrame(this.loop)
    if (!this.reducedMotion) {
      const t = this.clock.getElapsedTime()
      this.root.rotation.y = t * 0.35 // 缓慢自转
      this.root.position.y = Math.sin(t * 0.8) * 0.06 // 微浮动
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
    this.renderer.dispose()
  }
}
