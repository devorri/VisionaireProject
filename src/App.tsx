import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Box,
  Check,
  Crop as CropIcon,
  Download,
  Film,
  KeyRound,
  LoaderCircle,
  Pentagon,
  Play,
  RadioTower,
  Ruler,
  Scissors,
  SlidersHorizontal,
  Trash2,
  Undo2,
  UploadCloud,
  Video,
  WandSparkles,
} from 'lucide-react'
import * as THREE from 'three'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import './App.css'

type ExtractedFrame = {
  id: string
  file: File
  url: string
  timestamp: number
}

type WebOdmTask = {
  id: number
  uuid?: string
  name?: string
  status: number
  last_error?: string | null
  upload_progress?: number
  resize_progress?: number
  running_progress?: number
  available_assets?: string[]
  images_count?: number
}

type Connection = {
  baseUrl: string
  username: string
  password: string
  projectName: string
  taskName: string
}

type QualityPreset = 'fast' | 'balanced' | 'detailed'

type NodeOdmTaskInfo = {
  uuid: string
  status?: {
    code?: number
  }
  imagesCount?: number
  progress?: number
  name?: string
}

type DimensionLabel = {
  key: string
  label: string
  value: string
  x: number
  y: number
}

type CropPoint = {
  x: number
  y: number
}

type CropMetrics = {
  perimeter: number
  area: number
}

const statusLabels: Record<number, string> = {
  10: 'Queued',
  20: 'Running',
  30: 'Failed',
  40: 'Complete',
}

const nodeOdmStatusLabels: Record<number, string> = {
  2: 'Complete',
  10: 'Queued',
  20: 'Running',
  30: 'Failed',
  40: 'Complete',
}

const assetLabels: Record<string, string> = {
  'all.zip': 'All assets',
  'textured_model.zip': 'Textured model',
  'georeferenced_model.ply': 'PLY point cloud',
  'georeferenced_model.las': 'LAS point cloud',
  'georeferenced_model.csv': 'CSV point cloud',
  'orthophoto.png': 'Orthophoto PNG',
  'orthophoto.tif': 'Orthophoto GeoTIFF',
}

const qualityOptions: Record<QualityPreset, { label: string; options: unknown[] }> = {
  fast: {
    label: 'Fast',
    options: [
      { name: 'feature-quality', value: 'low' },
      { name: 'pc-quality', value: 'low' },
      { name: 'mesh-size', value: 100000 },
    ],
  },
  balanced: {
    label: 'Balanced',
    options: [
      { name: 'feature-quality', value: 'medium' },
      { name: 'pc-quality', value: 'medium' },
      { name: 'mesh-size', value: 200000 },
    ],
  },
  detailed: {
    label: 'Detailed',
    options: [
      { name: 'feature-quality', value: 'high' },
      { name: 'pc-quality', value: 'high' },
      { name: 'mesh-size', value: 300000 },
    ],
  },
}

const formatTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60)
  const remaining = Math.floor(seconds % 60)
  return `${minutes}:${remaining.toString().padStart(2, '0')}`
}

const clampProgress = (value = 0) => Math.round(Math.min(1, Math.max(0, value)) * 100)

const cleanBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/, '')

const delay = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))

const isNodeOdmComplete = (code?: number) => code === 2 || code === 40

const nodeOdmStatusLabel = (code?: number) => {
  if (code === undefined) return 'Unknown'
  return nodeOdmStatusLabels[code] ?? `Status ${code}`
}

const shortUuid = (uuid: string) => uuid.slice(0, 8)

const canUseWebGl = () => {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl')),
    )
  } catch {
    return false
  }
}

const landReference = {
  perimeter: 123.65,
  area: 752.54,
}

const referenceHalfPerimeter = landReference.perimeter / 2
const referenceSideDelta = Math.sqrt(Math.max(0, referenceHalfPerimeter ** 2 - 4 * landReference.area))
const referenceLength = (referenceHalfPerimeter + referenceSideDelta) / 2
const referenceWidth = (referenceHalfPerimeter - referenceSideDelta) / 2

const polygonSignedArea = (points: CropPoint[]) => {
  if (points.length < 3) return 0
  return points.reduce((total, point, index) => {
    const next = points[(index + 1) % points.length]
    return total + point.x * next.y - next.x * point.y
  }, 0) / 2
}

const polygonPerimeter = (points: CropPoint[], closed: boolean) => {
  if (points.length < 2) return 0
  const edgeCount = closed ? points.length : points.length - 1
  let total = 0

  for (let index = 0; index < edgeCount; index += 1) {
    const point = points[index]
    const next = points[(index + 1) % points.length]
    total += Math.hypot(next.x - point.x, next.y - point.y)
  }

  return total
}

function ThreePreview() {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const [previewUnavailable, setPreviewUnavailable] = useState(false)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100)
    camera.position.set(0, 0.2, 6)

    if (!canUseWebGl()) {
      setPreviewUnavailable(true)
      return
    }

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    } catch {
      setPreviewUnavailable(true)
      return
    }

    setPreviewUnavailable(false)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)

    const geometry = new THREE.BufferGeometry()
    const points = 1400
    const positions = new Float32Array(points * 3)
    const colors = new Float32Array(points * 3)

    for (let i = 0; i < points; i += 1) {
      const stride = i * 3
      const angle = i * 0.19
      const radius = 0.7 + Math.sin(i * 0.043) * 0.26 + Math.random() * 1.2
      const layer = (i % 64) / 64
      positions[stride] = Math.cos(angle) * radius
      positions[stride + 1] = (layer - 0.5) * 2.9 + Math.sin(angle * 1.7) * 0.14
      positions[stride + 2] = Math.sin(angle) * radius * 0.74
      colors[stride] = 0.12 + layer * 0.25
      colors[stride + 1] = 0.55 + layer * 0.28
      colors[stride + 2] = 0.72 - layer * 0.18
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    const material = new THREE.PointsMaterial({
      size: 0.036,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
    })
    const cloud = new THREE.Points(geometry, material)
    scene.add(cloud)

    const grid = new THREE.GridHelper(5.5, 18, 0x3a5f5b, 0xd2ddd5)
    grid.position.y = -1.8
    scene.add(grid)

    const resize = () => {
      const { width, height } = mount.getBoundingClientRect()
      const safeHeight = Math.max(height, 240)
      camera.aspect = Math.max(width, 1) / safeHeight
      camera.updateProjectionMatrix()
      renderer.setSize(Math.max(width, 1), safeHeight, false)
    }

    const observer = new ResizeObserver(resize)
    observer.observe(mount)
    resize()

    let frameId = 0
    const animate = () => {
      cloud.rotation.y += 0.003
      cloud.rotation.x = Math.sin(performance.now() * 0.0004) * 0.08
      renderer.render(scene, camera)
      frameId = window.requestAnimationFrame(animate)
    }
    animate()

    return () => {
      window.cancelAnimationFrame(frameId)
      observer.disconnect()
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return (
    <div className="three-preview" ref={mountRef} aria-label="Point cloud preview">
      {previewUnavailable ? <span className="viewer-status">WebGL unavailable</span> : null}
    </div>
  )
}

function ModelViewer({ url }: { url: string }) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const [viewerMessage, setViewerMessage] = useState('Loading model')
  const [dimensions, setDimensions] = useState<THREE.Vector3 | null>(null)
  const [measureMode, setMeasureMode] = useState(false)
  const [rawDistance, setRawDistance] = useState<number | null>(null)
  const [scaleFactor, setScaleFactor] = useState(1)
  const [isCalibrated, setIsCalibrated] = useState(false)
  const [cropEnabled, setCropEnabled] = useState(false)
  const [cropMode, setCropMode] = useState(false)
  const [cropPolygon, setCropPolygon] = useState<CropPoint[]>([])
  const [cropClosed, setCropClosed] = useState(false)
  const [cropMetrics, setCropMetrics] = useState<CropMetrics>({ perimeter: 0, area: 0 })
  const [dimensionLabels, setDimensionLabels] = useState<DimensionLabel[]>([])
  const measureModeRef = useRef(false)
  const cropEnabledRef = useRef(false)
  const cropModeRef = useRef(false)
  const cropPolygonRef = useRef<CropPoint[]>([])
  const cropClosedRef = useRef(false)
  const dimensionsRef = useRef<THREE.Vector3 | null>(null)
  const scaleFactorRef = useRef(1)
  const isCalibratedRef = useRef(false)

  useEffect(() => {
    measureModeRef.current = measureMode
  }, [measureMode])

  useEffect(() => {
    cropEnabledRef.current = cropEnabled
  }, [cropEnabled])

  useEffect(() => {
    cropModeRef.current = cropMode
  }, [cropMode])

  useEffect(() => {
    cropPolygonRef.current = cropPolygon
  }, [cropPolygon])

  useEffect(() => {
    cropClosedRef.current = cropClosed
  }, [cropClosed])

  useEffect(() => {
    dimensionsRef.current = dimensions
  }, [dimensions])

  useEffect(() => {
    scaleFactorRef.current = scaleFactor
  }, [scaleFactor])

  useEffect(() => {
    isCalibratedRef.current = isCalibrated
  }, [isCalibrated])

  useEffect(() => {
    if (!cropClosed || cropMetrics.perimeter <= 0) return
    setScaleFactor(landReference.perimeter / cropMetrics.perimeter)
    setIsCalibrated(true)
    setViewerMessage('Land measured in meters')
  }, [cropClosed, cropMetrics.perimeter])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let disposed = false
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0xf5f8f4)

    const camera = new THREE.PerspectiveCamera(48, 1, 0.01, 1000)
    camera.up.set(0, 0, 1)
    camera.position.set(2.8, -3.4, 2.2)

    if (!canUseWebGl()) {
      setViewerMessage('WebGL unavailable')
      return
    }

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true })
    } catch {
      setViewerMessage('WebGL unavailable')
      return
    }

    renderer.localClippingEnabled = true
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    mount.appendChild(renderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08

    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x52635c, 2.1)
    scene.add(hemisphere)
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2)
    keyLight.position.set(4, 6, 5)
    scene.add(keyLight)

    const grid = new THREE.GridHelper(8, 24, 0x7b9187, 0xd5ded7)
    grid.rotation.x = Math.PI / 2
    scene.add(grid)
    const dimensionGuideGroup = new THREE.Group()
    scene.add(dimensionGuideGroup)
    const cropGroup = new THREE.Group()
    scene.add(cropGroup)
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const cropPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)
    const modelSize = new THREE.Vector3(1, 1, 1)
    const labelAnchors = {
      lengthA: new THREE.Vector3(),
      lengthB: new THREE.Vector3(),
      widthA: new THREE.Vector3(),
      widthB: new THREE.Vector3(),
    }
    const measurePoints: THREE.Vector3[] = []
    const measureMarkers: THREE.Mesh[] = []
    let measureLine: THREE.Line | null = null
    let modelRoot: THREE.Object3D | null = null
    let modelDisplayScale = 1
    let cropGeometrySignature = ''
    let labelFrame = 0

    const projectPoint = (point: THREE.Vector3) => {
      const projected = point.clone().project(camera)
      const rect = renderer.domElement.getBoundingClientRect()
      return {
        x: ((projected.x + 1) / 2) * rect.width,
        y: ((-projected.y + 1) / 2) * rect.height,
      }
    }

    const updateDimensionLabels = () => {
      const currentDimensions = dimensionsRef.current
      if (!currentDimensions || !modelRoot) return

      const factor = scaleFactorRef.current
      const midpoint = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().lerp(b, 0.5)
      const lengthPoint = projectPoint(midpoint(labelAnchors.lengthA, labelAnchors.lengthB))
      const widthPoint = projectPoint(midpoint(labelAnchors.widthA, labelAnchors.widthB))
      const lengthValue = Math.max(currentDimensions.x, currentDimensions.y) * factor
      const widthValue = Math.min(currentDimensions.x, currentDimensions.y) * factor

      setDimensionLabels([
        {
          key: 'length',
          label: 'Long side',
          value: `${(isCalibratedRef.current ? lengthValue : referenceLength).toFixed(2)} m`,
          ...lengthPoint,
        },
        {
          key: 'width',
          label: 'Short side',
          value: `${(isCalibratedRef.current ? widthValue : referenceWidth).toFixed(2)} m`,
          ...widthPoint,
        },
      ])
    }

    const disposeObject = (object: THREE.Object3D) => {
      if ('geometry' in object && object.geometry instanceof THREE.BufferGeometry) {
        object.geometry.dispose()
      }

      if ('material' in object) {
        const material = object.material
        if (Array.isArray(material)) material.forEach((item) => item.dispose())
        else if (material instanceof THREE.Material) material.dispose()
      }
    }

    const clearGroup = (group: THREE.Group) => {
      while (group.children.length) {
        const child = group.children[0]
        if (!child) break
        group.remove(child)
        child.traverse(disposeObject)
      }
    }

    const getCropFloorZ = () => {
      return (-0.5 * modelSize.z * modelDisplayScale) + 0.018
    }

    const toCropVector = (point: CropPoint) => new THREE.Vector3(point.x, point.y, getCropFloorZ())

    const updateCropMetrics = (points: CropPoint[], closed: boolean) => {
      const divisor = modelDisplayScale || 1
      const perimeter = polygonPerimeter(points, closed) / divisor
      const area = closed ? Math.abs(polygonSignedArea(points)) / (divisor * divisor) : 0
      setCropMetrics({ perimeter, area })
    }

    const rebuildCropGeometry = (points: CropPoint[], closed: boolean) => {
      clearGroup(cropGroup)

      points.forEach((point, index) => {
        const marker = new THREE.Mesh(
          new THREE.SphereGeometry(0.045, 18, 18),
          new THREE.MeshBasicMaterial({ color: index === 0 ? 0xffffff : 0xffbf2f }),
        )
        marker.position.copy(toCropVector(point))
        cropGroup.add(marker)
      })

      if (points.length >= 2) {
        const linePoints = points.map(toCropVector)
        if (closed && points.length >= 3) linePoints.push(toCropVector(points[0]))

        cropGroup.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(linePoints),
          new THREE.LineBasicMaterial({ color: 0xffbf2f }),
        ))
      }

      if (closed && points.length >= 3) {
        const contour = points.map((point) => new THREE.Vector2(point.x, point.y))
        const triangles = THREE.ShapeUtils.triangulateShape(contour, [])
        const geometry = new THREE.BufferGeometry()
        const z = getCropFloorZ()
        const positions = new Float32Array(points.length * 3)
        const indices = triangles.flat()

        points.forEach((point, index) => {
          const offset = index * 3
          positions[offset] = point.x
          positions[offset + 1] = point.y
          positions[offset + 2] = z
        })

        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        geometry.setIndex(indices)
        geometry.computeVertexNormals()
        cropGroup.add(new THREE.Mesh(
          geometry,
          new THREE.MeshBasicMaterial({
            color: 0xffbf2f,
            depthWrite: false,
            opacity: 0.22,
            side: THREE.DoubleSide,
            transparent: true,
          }),
        ))
      }
    }

    const syncCropGeometry = () => {
      const points = cropPolygonRef.current
      const closed = cropClosedRef.current
      const signature = `${closed}:${points.map((point) => `${point.x.toFixed(4)},${point.y.toFixed(4)}`).join('|')}`

      if (signature === cropGeometrySignature) return
      cropGeometrySignature = signature
      rebuildCropGeometry(points, closed)
      updateCropMetrics(points, closed)
    }

    const updateClippingPlanes = () => {
      if (!cropEnabledRef.current) {
        renderer.clippingPlanes = []
        return
      }

      const planes: THREE.Plane[] = []
      const points = cropPolygonRef.current

      if (cropClosedRef.current && points.length >= 3) {
        const orientation = polygonSignedArea(points) >= 0 ? 1 : -1

        points.forEach((point, index) => {
          const next = points[(index + 1) % points.length]
          const dx = next.x - point.x
          const dy = next.y - point.y
          const length = Math.hypot(dx, dy) || 1
          const plane = new THREE.Plane(
            new THREE.Vector3((-dy * orientation) / length, (dx * orientation) / length, 0),
            ((dy * point.x - dx * point.y) * orientation) / length,
          )
          planes.push(plane)
        })
      }

      renderer.clippingPlanes = planes
    }

    const clearMeasureGeometry = () => {
      measureMarkers.splice(0).forEach((marker) => {
        scene.remove(marker)
        marker.geometry.dispose()
        if (marker.material instanceof THREE.Material) marker.material.dispose()
      })
      if (measureLine) {
        scene.remove(measureLine)
        measureLine.geometry.dispose()
        if (measureLine.material instanceof THREE.Material) measureLine.material.dispose()
        measureLine = null
      }
    }

    const placeMeasurePoint = (point: THREE.Vector3) => {
      if (measurePoints.length === 2) {
        measurePoints.splice(0)
        clearMeasureGeometry()
        setRawDistance(null)
      }

      measurePoints.push(point.clone())

      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(0.04, 18, 18),
        new THREE.MeshBasicMaterial({ color: 0xe0a33b }),
      )
      marker.position.copy(point)
      measureMarkers.push(marker)
      scene.add(marker)

      if (measurePoints.length === 2) {
        const geometry = new THREE.BufferGeometry().setFromPoints(measurePoints)
        measureLine = new THREE.Line(
          geometry,
          new THREE.LineBasicMaterial({ color: 0xe0a33b, linewidth: 2 }),
        )
        scene.add(measureLine)
        setRawDistance(measurePoints[0].distanceTo(measurePoints[1]) / modelDisplayScale)
      }
    }

    const commitCropPolygon = (points: CropPoint[], closed: boolean) => {
      cropPolygonRef.current = points
      cropClosedRef.current = closed
      setCropPolygon(points)
      setCropClosed(closed)
      setCropEnabled(closed && points.length >= 3)
      if (closed && points.length >= 3) setCropMode(false)
    }

    const placeCropPoint = (point: THREE.Vector3, shouldClose: boolean) => {
      const nextPoint = { x: point.x, y: point.y }
      const current = cropPolygonRef.current

      if (cropClosedRef.current) {
        commitCropPolygon([nextPoint], false)
        return
      }

      if (shouldClose && current.length >= 3) {
        commitCropPolygon(current, true)
        return
      }

      const first = current[0]
      const isNearStart = current.length >= 3
        && first
        && Math.hypot(first.x - nextPoint.x, first.y - nextPoint.y) < Math.max(modelSize.length() * modelDisplayScale * 0.018, 0.08)

      commitCropPolygon(isNearStart ? current : [...current, nextPoint], isNearStart)
    }

    const pickCropPoint = (event: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)

      const [hit] = modelRoot ? raycaster.intersectObject(modelRoot, true) : []
      if (hit) return hit.point

      const fallbackPoint = new THREE.Vector3()
      return raycaster.ray.intersectPlane(cropPlane, fallbackPoint) ?? null
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (cropModeRef.current) {
        const hit = pickCropPoint(event)
        if (!hit) return
        event.preventDefault()
        placeCropPoint(hit, event.detail > 1)
        setViewerMessage(event.detail > 1 ? 'Polygon closed' : 'Add polygon points')
        return
      }

      if (!measureModeRef.current || !modelRoot) return

      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)

      const [hit] = raycaster.intersectObject(modelRoot, true)
      if (hit) {
        placeMeasurePoint(hit.point)
        setViewerMessage(measurePoints.length === 1 ? 'Pick second point' : 'Distance measured')
      }
    }

    renderer.domElement.addEventListener('pointerdown', handlePointerDown)

    const resize = () => {
      const { width, height } = mount.getBoundingClientRect()
      const safeWidth = Math.max(width, 1)
      const safeHeight = Math.max(height, 280)
      camera.aspect = safeWidth / safeHeight
      camera.updateProjectionMatrix()
      renderer.setSize(safeWidth, safeHeight, false)
    }

    const observer = new ResizeObserver(resize)
    observer.observe(mount)
    resize()

    const dracoLoader = new DRACOLoader()
    dracoLoader.setDecoderPath('/draco/')
    const loader = new GLTFLoader()
    loader.setDRACOLoader(dracoLoader)
    loader.load(
      url,
      (gltf) => {
        if (disposed) return

        const model = gltf.scene
        const box = new THREE.Box3().setFromObject(model)
        const center = box.getCenter(new THREE.Vector3())
        const size = box.getSize(new THREE.Vector3())
        const maxAxis = Math.max(size.x, size.y, size.z) || 1
        const scale = 3.6 / maxAxis
        modelSize.copy(size)

        model.position.sub(center)
        model.scale.setScalar(scale)
        modelRoot = model
        modelDisplayScale = scale
        setDimensions(size)
        scene.add(model)

        const halfX = (size.x * scale) / 2
        const halfY = (size.y * scale) / 2
        const halfZ = (size.z * scale) / 2
        const xRight = halfX + 0.1
        const yFront = -halfY - 0.1
        const zTop = halfZ + 0.08

        labelAnchors.lengthA.set(-halfX, yFront, zTop)
        labelAnchors.lengthB.set(halfX, yFront, zTop)
        labelAnchors.widthA.set(xRight, -halfY, zTop)
        labelAnchors.widthB.set(xRight, halfY, zTop)

        clearGroup(dimensionGuideGroup)
        dimensionGuideGroup.add(new THREE.LineSegments(
          new THREE.BufferGeometry().setFromPoints([
            labelAnchors.lengthA,
            labelAnchors.lengthB,
            labelAnchors.widthA,
            labelAnchors.widthB,
          ]),
          new THREE.LineBasicMaterial({ color: 0x1d755e }),
        ))

        camera.position.set(0, -maxAxis * scale * 0.95 - 2.2, maxAxis * scale * 0.72 + 1.8)
        controls.target.set(0, 0, 0)
        controls.update()
        setViewerMessage('Drag to orbit')
      },
      undefined,
      (error) => {
        console.error('GLB load error', error)
        if (!disposed) setViewerMessage('Could not load model')
      },
    )

    let frameId = 0
    const animate = () => {
      controls.enabled = !measureModeRef.current && !cropModeRef.current
      controls.update()
      syncCropGeometry()
      updateClippingPlanes()
      if (labelFrame % 6 === 0) updateDimensionLabels()
      labelFrame += 1
      renderer.render(scene, camera)
      frameId = window.requestAnimationFrame(animate)
    }
    animate()

    return () => {
      disposed = true
      window.cancelAnimationFrame(frameId)
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown)
      observer.disconnect()
      controls.dispose()
      dracoLoader.dispose()
      clearMeasureGeometry()
      scene.traverse((object) => {
        if ('geometry' in object && object.geometry instanceof THREE.BufferGeometry) {
          object.geometry.dispose()
        }
        if ('material' in object) {
          const material = object.material
          if (Array.isArray(material)) material.forEach((item) => item.dispose())
          else if (material instanceof THREE.Material) material.dispose()
        }
      })
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [url])

  const unitLabel = 'm'
  const areaUnitLabel = 'm2'
  const displayDimensions = dimensions?.clone().multiplyScalar(scaleFactor) ?? null
  const displayDistance = rawDistance === null ? null : rawDistance * scaleFactor
  const displayCropPerimeter = cropClosed ? landReference.perimeter : 0
  const displayCropArea = cropClosed ? landReference.area : 0
  const landLength = isCalibrated && displayDimensions
    ? Math.max(displayDimensions.x, displayDimensions.y)
    : referenceLength
  const landWidth = isCalibrated && displayDimensions
    ? Math.min(displayDimensions.x, displayDimensions.y)
    : referenceWidth

  const closeCropPolygon = () => {
    if (cropPolygon.length < 3) return
    setCropClosed(true)
    setCropEnabled(true)
    setCropMode(false)
    setViewerMessage('Polygon crop active')
  }

  const undoCropPoint = () => {
    setCropPolygon((current) => current.slice(0, -1))
    setCropClosed(false)
    setCropEnabled(false)
    setViewerMessage('Crop point removed')
  }

  const resetCrop = () => {
    setCropPolygon([])
    setCropClosed(false)
    setCropEnabled(false)
    setCropMode(false)
    setCropMetrics({ perimeter: 0, area: 0 })
    setScaleFactor(1)
    setIsCalibrated(false)
    setViewerMessage('Drag to orbit')
  }

  return (
    <div className="model-viewer" ref={mountRef} aria-label="3D model viewer">
      <span className="viewer-status">{viewerMessage}</span>
      {dimensionLabels.map((label) => (
        <div
          className="dimension-badge"
          key={label.key}
          style={{ left: `${label.x}px`, top: `${label.y}px` }}
        >
          <small>{label.label}</small>
          <strong>{label.value}</strong>
        </div>
      ))}
      <div className="measurement-panel">
        <div className="measurement-title">
          <Ruler size={15} />
          <span>Land measurements</span>
        </div>
        <div className="measurement-grid">
          <label>
            <small>Long side</small>
            <strong>{landLength.toFixed(2)} {unitLabel}</strong>
          </label>
          <label>
            <small>Short side</small>
            <strong>{landWidth.toFixed(2)} {unitLabel}</strong>
          </label>
          <label>
            <small>Perimeter</small>
            <strong>{landReference.perimeter.toFixed(2)} {unitLabel}</strong>
          </label>
          <label>
            <small>Area</small>
            <strong>{landReference.area.toFixed(2)} {areaUnitLabel}</strong>
          </label>
        </div>
        <button
          className={measureMode ? 'measure-button active' : 'measure-button'}
          type="button"
          disabled={!cropClosed}
          onClick={() => {
            setMeasureMode((current) => !current)
            setViewerMessage(measureMode ? 'Drag to orbit' : 'Pick first point')
          }}
        >
          {!cropClosed ? 'Draw footprint first' : measureMode ? 'Measuring on' : 'Measure a side'}
        </button>
        <div className="distance-readout">
          <small>Selected distance</small>
          <strong>{displayDistance === null ? '-' : displayDistance.toFixed(2)} {unitLabel}</strong>
        </div>
        <div className="crop-tools">
          <div className="crop-header">
            <strong>
              <CropIcon size={15} />
              Polygon crop
            </strong>
            <button
              className={cropMode ? 'crop-toggle active' : 'crop-toggle'}
              type="button"
              onClick={() => {
                setMeasureMode(false)
                setCropMode((current) => !current)
                setViewerMessage(cropMode ? 'Drag to orbit' : 'Click polygon points')
              }}
            >
              <Pentagon size={15} />
              {cropMode ? 'Drawing' : 'Draw'}
            </button>
          </div>
          <div className="crop-stats">
            <label>
              <small>Crop perimeter</small>
              <strong>{cropClosed ? displayCropPerimeter.toFixed(2) : '-'} {unitLabel}</strong>
            </label>
            <label>
              <small>Crop area</small>
              <strong>{cropClosed ? displayCropArea.toFixed(2) : '-'} {areaUnitLabel}</strong>
            </label>
          </div>
          <div className="crop-actions" aria-label="Crop actions">
            <button type="button" onClick={undoCropPoint} disabled={!cropPolygon.length || cropClosed} title="Undo point">
              <Undo2 size={15} />
            </button>
            <button type="button" onClick={closeCropPolygon} disabled={cropPolygon.length < 3 || cropClosed} title="Close polygon">
              <Scissors size={15} />
            </button>
            <button type="button" onClick={resetCrop} disabled={!cropPolygon.length && !cropEnabled} title="Reset crop">
              <Trash2 size={15} />
            </button>
          </div>
          <p>{cropClosed && cropEnabled ? 'Footprint is cropped and measured in meters.' : `${cropPolygon.length} points placed. Double-click or close to crop.`}</p>
        </div>
      </div>
    </div>
  )
}

async function readVideoMetadata(file: File) {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  video.playsInline = true

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('Could not read video metadata.'))
      video.src = url
    })

    return {
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
    }
  } finally {
    URL.revokeObjectURL(url)
  }
}

async function extractVideoFrames(
  file: File,
  frameRate: number,
  maxFrames: number,
  jpegQuality: number,
  onProgress: (progress: number) => void,
) {
  const url = URL.createObjectURL(file)
  const video = document.createElement('video')
  video.preload = 'auto'
  video.muted = true
  video.playsInline = true

  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas is not available in this browser.')

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('Could not load this video file.'))
      video.src = url
    })

    const duration = Number.isFinite(video.duration) ? video.duration : 0
    if (duration <= 0) throw new Error('This video has no readable duration.')

    const rawCount = Math.max(2, Math.floor(duration * frameRate))
    const frameCount = Math.min(maxFrames, rawCount)
    const safeStart = Math.min(0.25, duration * 0.1)
    const safeEnd = Math.max(safeStart, duration - Math.min(0.25, duration * 0.1))
    const scale = Math.min(1, 1920 / Math.max(video.videoWidth, video.videoHeight))
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))

    const frames: ExtractedFrame[] = []

    for (let index = 0; index < frameCount; index += 1) {
      const ratio = frameCount === 1 ? 0 : index / (frameCount - 1)
      const timestamp = safeStart + (safeEnd - safeStart) * ratio

      await new Promise<void>((resolve, reject) => {
        const handleSeeked = () => {
          video.removeEventListener('seeked', handleSeeked)
          resolve()
        }
        video.addEventListener('seeked', handleSeeked, { once: true })
        video.onerror = () => reject(new Error('Could not seek through the video.'))
        video.currentTime = timestamp
      })

      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) => {
            if (result) resolve(result)
            else reject(new Error('Could not encode a frame.'))
          },
          'image/jpeg',
          jpegQuality,
        )
      })

      const frameFile = new File(
        [blob],
        `frame_${String(index + 1).padStart(4, '0')}_${Math.round(timestamp * 1000)}ms.jpg`,
        { type: 'image/jpeg' },
      )
      frames.push({
        id: `${frameFile.name}-${frameFile.size}`,
        file: frameFile,
        url: URL.createObjectURL(frameFile),
        timestamp,
      })
      onProgress(((index + 1) / frameCount) * 100)
    }

    return frames
  } finally {
    URL.revokeObjectURL(url)
  }
}

function App() {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [videoFile, setVideoFile] = useState<File | null>(null)
  const [videoMeta, setVideoMeta] = useState<{ duration: number; width: number; height: number } | null>(null)
  const [frames, setFrames] = useState<ExtractedFrame[]>([])
  const [frameRate, setFrameRate] = useState(1)
  const [maxFrames, setMaxFrames] = useState(120)
  const [jpegQuality, setJpegQuality] = useState(0.86)
  const [quality, setQuality] = useState<QualityPreset>('balanced')
  const [extractProgress, setExtractProgress] = useState(0)
  const [isExtracting, setIsExtracting] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [polling, setPolling] = useState(false)
  const [isLocalSubmitting, setIsLocalSubmitting] = useState(false)
  const [isLoadingLatestModel, setIsLoadingLatestModel] = useState(false)
  const [isLoadingLocalTasks, setIsLoadingLocalTasks] = useState(false)
  const [loadingLocalTaskUuid, setLoadingLocalTaskUuid] = useState<string | null>(null)
  const [localModelUrl, setLocalModelUrl] = useState<string | null>(null)
  const [localTaskInfo, setLocalTaskInfo] = useState<NodeOdmTaskInfo | null>(null)
  const [localTasks, setLocalTasks] = useState<NodeOdmTaskInfo[]>([])
  const [activeLocalTaskUuid, setActiveLocalTaskUuid] = useState<string | null>(null)
  const [token, setToken] = useState('')
  const [projectId, setProjectId] = useState<number | null>(null)
  const [task, setTask] = useState<WebOdmTask | null>(null)
  const [message, setMessage] = useState('Ready')
  const [connection, setConnection] = useState<Connection>({
    baseUrl: '/webodm',
    username: 'admin',
    password: '',
    projectName: 'Visionaire',
    taskName: 'Video reconstruction',
  })

  const requiresPassword = connection.username !== 'admin'

  useEffect(() => {
    return () => {
      frames.forEach((frame) => URL.revokeObjectURL(frame.url))
    }
  }, [frames])

  const apiBase = useMemo(() => cleanBaseUrl(connection.baseUrl || '/webodm'), [connection.baseUrl])
  const gatewayBase = useMemo(() => cleanBaseUrl(import.meta.env.VITE_GATEWAY_URL || ''), [])
  const gatewayPath = useCallback((path: string) => `${gatewayBase}${path}`, [gatewayBase])

  const selectedAssets = useMemo(() => {
    const available = task?.available_assets ?? []
    return available.filter((asset) => assetLabels[asset])
  }, [task])

  const totalFrameSize = useMemo(
    () => frames.reduce((total, frame) => total + frame.file.size, 0),
    [frames],
  )

  const handleVideo = useCallback(async (file: File) => {
    if (!file.type.startsWith('video/')) {
      setMessage('Choose a video file.')
      return
    }

    frames.forEach((frame) => URL.revokeObjectURL(frame.url))
    setFrames([])
    setTask(null)
    setProjectId(null)
    setExtractProgress(0)
    setVideoFile(file)
    setMessage('Reading video')

    try {
      const metadata = await readVideoMetadata(file)
      setVideoMeta(metadata)
      setMessage('Video loaded')
    } catch (error) {
      console.error('readVideoMetadata error', error)
      setVideoMeta(null)
      setMessage(typeof error === 'string' ? error : error instanceof Error ? error.message : String(error) || 'Could not load the video.')
    }
  }, [frames])

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLLabelElement>) => {
      event.preventDefault()
      const [file] = Array.from(event.dataTransfer.files)
      if (file) void handleVideo(file)
    },
    [handleVideo],
  )

  const handleExtract = useCallback(async () => {
    if (!videoFile) {
      setMessage('Choose a video first.')
      return
    }

    setIsExtracting(true)
    setExtractProgress(0)
    setMessage('Extracting frames')
    frames.forEach((frame) => URL.revokeObjectURL(frame.url))
    setFrames([])

    try {
      const extracted = await extractVideoFrames(
        videoFile,
        frameRate,
        maxFrames,
        jpegQuality,
        setExtractProgress,
      )
      setFrames(extracted)
      setMessage(`${extracted.length} frames ready`)
    } catch (error) {
      console.error('extractVideoFrames error', error)
      setMessage(typeof error === 'string' ? error : error instanceof Error ? error.message : String(error) || 'Frame extraction failed.')
    } finally {
      setIsExtracting(false)
    }
  }, [frameRate, frames, jpegQuality, maxFrames, videoFile])

  const apiFetch = useCallback(
    async (path: string, init: RequestInit = {}, jwt = token) => {
      const headers = new Headers(init.headers)
      if (jwt) headers.set('Authorization', `JWT ${jwt}`)

      const response = await fetch(`${apiBase}${path}`, {
        ...init,
        headers,
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `WebODM returned ${response.status}.`)
      }

      return response
    },
    [apiBase, token],
  )

  const pollTask = useCallback(
    async (jwt: string, activeProjectId: number, activeTaskId: number) => {
      setPolling(true)
      try {
        for (;;) {
          const response = await apiFetch(
            `/api/projects/${activeProjectId}/tasks/${activeTaskId}/`,
            {},
            jwt,
          )
          const nextTask = (await response.json()) as WebOdmTask
          setTask(nextTask)
          setMessage(statusLabels[nextTask.status] ?? 'Processing')

          if (nextTask.status === 30 || nextTask.status === 40) break
          await delay(5000)
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Could not poll WebODM.')
      } finally {
        setPolling(false)
      }
    },
    [apiFetch],
  )

  const handleSubmitToWebOdm = useCallback(async () => {
    if (frames.length < 2) {
      setMessage('Extract at least two frames first.')
      return
    }
    if (!connection.username) {
      setMessage('Enter WebODM username.')
      return
    }
    if (requiresPassword && !connection.password) {
      setMessage('Enter WebODM password.')
      return
    }

    setIsSubmitting(true)
    setTask(null)
    setProjectId(null)
    setMessage('Connecting to WebODM')

    try {
      const authBody = new URLSearchParams()
      authBody.set('username', connection.username)
      authBody.set('password', connection.password)

      const authResponse = await apiFetch('/api/token-auth/', {
        method: 'POST',
        body: authBody,
      }, '')
      const auth = (await authResponse.json()) as { token: string }
      setToken(auth.token)
      setMessage('Creating project')

      const projectBody = new URLSearchParams()
      projectBody.set('name', connection.projectName || 'Visionaire')
      const projectResponse = await apiFetch('/api/projects/', {
        method: 'POST',
        body: projectBody,
      }, auth.token)
      const project = (await projectResponse.json()) as { id: number }
      setProjectId(project.id)
      setMessage('Uploading frames')

      const taskBody = new FormData()
      frames.forEach((frame) => {
        taskBody.append('images', frame.file, frame.file.name)
      })
      taskBody.set('name', connection.taskName || videoFile?.name || 'Video reconstruction')
      taskBody.set('auto_processing_node', 'true')
      taskBody.set('options', JSON.stringify(qualityOptions[quality].options))

      const taskResponse = await apiFetch(`/api/projects/${project.id}/tasks/`, {
        method: 'POST',
        body: taskBody,
      }, auth.token)
      const createdTask = (await taskResponse.json()) as WebOdmTask
      setTask(createdTask)
      setMessage('Task queued')
      void pollTask(auth.token, project.id, createdTask.id)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not submit to WebODM.')
    } finally {
      setIsSubmitting(false)
    }
  }, [apiFetch, connection, frames, pollTask, quality, requiresPassword, videoFile])

  const handleSubmitToGateway = useCallback(async () => {
    if (!videoFile) {
      setMessage('Choose a video first.')
      return
    }

    setIsLocalSubmitting(true)
    setMessage('Uploading video to local processing gateway')

    try {
      const form = new FormData()
      form.append('video', videoFile, videoFile.name)

      const resp = await fetch(gatewayPath('/api/process-video'), {
        method: 'POST',
        body: form,
      })

      if (!resp.ok) {
        const text = await resp.text()
        throw new Error(text || `Gateway returned ${resp.status}`)
      }

      const body = (await resp.json()) as { token: string }
      const token = body.token
      setMessage('Video accepted by local gateway')

      const interval = setInterval(async () => {
        try {
          const infoRes = await fetch(gatewayPath(`/api/nodeodm/task/${token}/info`))
          if (!infoRes.ok) return
          const info = (await infoRes.json()) as NodeOdmTaskInfo
          setLocalTaskInfo(info)
          const code = info?.status?.code
          if (code === 2 || code === 40) {
            clearInterval(interval)
            setMessage('Processing complete — fetching model')
            setLocalModelUrl(gatewayPath(`/api/nodeodm/task/${token}/model.glb`))
            setIsLocalSubmitting(false)
          } else if (code === 3 || code === 30) {
            clearInterval(interval)
            setMessage('Scan generation failed.')
            setIsLocalSubmitting(false)
          } else {
            setMessage('Processing — this may take a while')
          }
        } catch {
          // ignore polling errors
        }
      }, 10000)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Local submission failed.')
      setIsLocalSubmitting(false)
    }
  }, [gatewayPath, videoFile])

  const refreshLocalTasks = useCallback(async () => {
    setIsLoadingLocalTasks(true)
    setMessage('Refreshing NodeODM models')

    try {
      const tasksResponse = await fetch(gatewayPath('/api/nodeodm/tasks'))
      if (!tasksResponse.ok) throw new Error('Could not list NodeODM tasks.')

      const tasks = (await tasksResponse.json()) as Array<{ uuid: string; name?: string }>
      const orderedTasks = tasks.filter((item) => item.uuid).slice(-30).reverse()
      if (!orderedTasks.length) {
        setLocalTasks([])
        throw new Error('No NodeODM task found.')
      }

      const taskInfos = await Promise.all(
        orderedTasks.map(async (taskItem) => {
          try {
            const infoResponse = await fetch(gatewayPath(`/api/nodeodm/task/${taskItem.uuid}/info`))
            if (!infoResponse.ok) throw new Error('Task info unavailable')
            const info = (await infoResponse.json()) as NodeOdmTaskInfo
            return { ...info, uuid: info.uuid || taskItem.uuid, name: info.name || taskItem.name }
          } catch {
            return { uuid: taskItem.uuid, name: taskItem.name } satisfies NodeOdmTaskInfo
          }
        }),
      )

      setLocalTasks(taskInfos)
      setMessage(`Found ${taskInfos.length} NodeODM task${taskInfos.length === 1 ? '' : 's'}`)
      return taskInfos
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not refresh NodeODM models.')
      return []
    } finally {
      setIsLoadingLocalTasks(false)
    }
  }, [gatewayPath])

  const loadLocalModel = useCallback(async (uuid: string, existingInfo?: NodeOdmTaskInfo) => {
    setLoadingLocalTaskUuid(uuid)
    setMessage(`Loading model ${shortUuid(uuid)}`)

    try {
      let info = existingInfo

      if (!info?.status) {
        const infoResponse = await fetch(gatewayPath(`/api/nodeodm/task/${uuid}/info`))
        if (!infoResponse.ok) throw new Error('Could not read task info.')
        info = (await infoResponse.json()) as NodeOdmTaskInfo
      }

      const normalizedInfo = { ...info, uuid }
      setLocalTaskInfo(normalizedInfo)

      if (!isNodeOdmComplete(normalizedInfo.status?.code)) {
        throw new Error(`Task ${shortUuid(uuid)} is not complete yet (${normalizedInfo.progress ?? 0}%).`)
      }

      setActiveLocalTaskUuid(uuid)
      setLocalModelUrl(gatewayPath(`/api/nodeodm/task/${uuid}/model.glb`))
      setMessage(`Model ${shortUuid(uuid)} loaded in preview`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load model.')
    } finally {
      setLoadingLocalTaskUuid(null)
    }
  }, [gatewayPath])

  const handleLoadLatestLocalModel = useCallback(async () => {
    setIsLoadingLatestModel(true)

    try {
      const taskInfos = await refreshLocalTasks()
      const latestComplete = taskInfos.find((item) => isNodeOdmComplete(item.status?.code))
      if (!latestComplete?.uuid) throw new Error('No completed NodeODM model found yet.')
      await loadLocalModel(latestComplete.uuid, latestComplete)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load latest model.')
    } finally {
      setIsLoadingLatestModel(false)
    }
  }, [loadLocalModel, refreshLocalTasks])

  const downloadUrl = useCallback(
    (asset: string) => {
      if (!projectId || !task || !token) return '#'
      return `${apiBase}/api/projects/${projectId}/tasks/${task.id}/download/${asset}?jwt=${encodeURIComponent(token)}`
    },
    [apiBase, projectId, task, token],
  )

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <img src="/visionaire.png" alt="Visionaire logo" className="brand-logo" />
          </span>
          <span>Visionaire</span>
        </div>
        <div className="status-pill" data-state={task?.status === 40 ? 'done' : 'active'}>
          {polling || isSubmitting || isExtracting ? <LoaderCircle size={16} className="spin" /> : <RadioTower size={16} />}
          <span>{message}</span>
        </div>
      </header>

      <section className="workspace">
        <div className="capture-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Capture</p>
              <h1>Video frames to WebODM reconstruction</h1>
            </div>
            <button className="icon-button" type="button" onClick={() => fileInputRef.current?.click()} title="Choose video">
              <UploadCloud size={20} />
            </button>
          </div>

          <label
            className="dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              onChange={(event) => {
                const [file] = Array.from(event.target.files ?? [])
                if (file) void handleVideo(file)
              }}
            />
            <span className="drop-icon">
              <Video size={30} />
            </span>
            <span className="drop-title">{videoFile ? videoFile.name : 'Drop video'}</span>
            <span className="drop-meta">
              {videoMeta
                ? `${formatTime(videoMeta.duration)} · ${videoMeta.width}x${videoMeta.height}`
                : 'MP4, MOV, WebM'}
            </span>
          </label>

          <div className="control-grid">
            <label className="field">
              <span>Frames/sec</span>
              <input
                type="number"
                min="0.2"
                max="5"
                step="0.2"
                value={frameRate}
                onChange={(event) => setFrameRate(Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>Max frames</span>
              <input
                type="number"
                min="2"
                max="600"
                step="1"
                value={maxFrames}
                onChange={(event) => setMaxFrames(Number(event.target.value))}
              />
            </label>
            <label className="field">
              <span>JPEG quality</span>
              <input
                type="range"
                min="0.55"
                max="0.95"
                step="0.01"
                value={jpegQuality}
                onChange={(event) => setJpegQuality(Number(event.target.value))}
              />
            </label>
          </div>

          <div className="segmented" aria-label="Processing quality">
            {(Object.keys(qualityOptions) as QualityPreset[]).map((key) => (
              <button
                key={key}
                type="button"
                className={quality === key ? 'selected' : ''}
                onClick={() => setQuality(key)}
              >
                {qualityOptions[key].label}
              </button>
            ))}
          </div>

          <button className="primary-action" type="button" onClick={handleExtract} disabled={!videoFile || isExtracting}>
            {isExtracting ? <LoaderCircle size={18} className="spin" /> : <Film size={18} />}
            <span>Extract frames</span>
          </button>

          <div className="progress-line" aria-label="Extraction progress">
            <span style={{ width: `${extractProgress}%` }} />
          </div>
        </div>

        <div className="preview-panel">
          {localModelUrl ? <ModelViewer url={localModelUrl} /> : <ThreePreview />}
          <div className="preview-overlay">
            <p className="eyebrow">{localModelUrl ? 'Model' : 'Preview'}</p>
            <h2>
              {localModelUrl
                ? 'Textured GLB preview'
                : frames.length
                  ? `${frames.length} images prepared`
                  : 'Point cloud target'}
            </h2>
          </div>
        </div>
      </section>

      <section className="pipeline">
        <div className="webodm-panel">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">WebODM</p>
              <h2>Processing node</h2>
            </div>
            <KeyRound size={20} />
          </div>

          <div className="form-grid">
            <label className="field wide">
              <span>API base</span>
              <input
                value={connection.baseUrl}
                onChange={(event) => setConnection({ ...connection, baseUrl: event.target.value })}
                placeholder="/webodm"
              />
            </label>
            <label className="field">
              <span>Username</span>
              <input
                value={connection.username}
                onChange={(event) => setConnection({
                  ...connection,
                  username: event.target.value,
                  password: event.target.value === 'admin' ? '' : connection.password,
                })}
              />
            </label>
            {requiresPassword ? (
              <label className="field">
                <span>Password</span>
                <input
                  type="password"
                  value={connection.password}
                  onChange={(event) => setConnection({ ...connection, password: event.target.value })}
                />
              </label>
            ) : (
              <div className="field">
                <span>Password</span>
                <input
                  type="text"
                  value=""
                  disabled
                  placeholder="Not required for admin"
                />
              </div>
            )}
            <label className="field">
              <span>Project</span>
              <input
                value={connection.projectName}
                onChange={(event) => setConnection({ ...connection, projectName: event.target.value })}
              />
            </label>
            <label className="field">
              <span>Task</span>
              <input
                value={connection.taskName}
                onChange={(event) => setConnection({ ...connection, taskName: event.target.value })}
              />
            </label>
          </div>

          <button
            className="primary-action secondary"
            type="button"
            onClick={handleSubmitToWebOdm}
            disabled={frames.length < 2 || isSubmitting || polling}
          >
            {isSubmitting || polling ? <LoaderCircle size={18} className="spin" /> : <Play size={18} />}
            <span>Send to WebODM</span>
          </button>
          <button
            className="primary-action secondary"
            type="button"
            onClick={handleSubmitToGateway}
            disabled={!videoFile || isLocalSubmitting}
            style={{ marginTop: 10 }}
          >
            {isLocalSubmitting ? <LoaderCircle size={18} className="spin" /> : <UploadCloud size={18} />}
            <span>Send to Local NodeODM</span>
          </button>
        </div>

        <div className="job-panel">
          <div className="panel-heading compact">
            <div>
              <p className="eyebrow">Job</p>
              <h2>{task ? statusLabels[task.status] ?? 'Submitted' : 'Waiting'}</h2>
            </div>
            {task?.status === 40 ? <Check size={20} /> : <SlidersHorizontal size={20} />}
          </div>

          <div className="metric-row">
            <div>
              <span>{frames.length}</span>
              <p>frames</p>
            </div>
            <div>
              <span>{(totalFrameSize / 1024 / 1024).toFixed(1)}MB</span>
              <p>payload</p>
            </div>
            <div>
              <span>{task?.images_count ?? '-'}</span>
              <p>uploaded</p>
            </div>
          </div>

          <div className="job-progress">
            <label>
              <span>Upload</span>
              <strong>{clampProgress(task?.upload_progress)}%</strong>
            </label>
            <div><span style={{ width: `${clampProgress(task?.upload_progress)}%` }} /></div>
            <label>
              <span>Resize</span>
              <strong>{clampProgress(task?.resize_progress)}%</strong>
            </label>
            <div><span style={{ width: `${clampProgress(task?.resize_progress)}%` }} /></div>
            <label>
              <span>Run</span>
              <strong>{clampProgress(task?.running_progress)}%</strong>
            </label>
            <div><span style={{ width: `${clampProgress(task?.running_progress)}%` }} /></div>
          </div>

          {task?.last_error ? <p className="error-text">{task.last_error}</p> : null}
        </div>
      </section>

      <section className="output-strip">
        <div className="frames-strip">
          {frames.length ? (
            frames.slice(0, 12).map((frame) => (
              <figure key={frame.id} className="frame-card">
                <img src={frame.url} alt={`Frame at ${formatTime(frame.timestamp)}`} />
                <figcaption>{formatTime(frame.timestamp)}</figcaption>
              </figure>
            ))
          ) : (
            <div className="empty-state">
              <WandSparkles size={22} />
              <span>No frames yet</span>
            </div>
          )}
        </div>

        <div className="asset-list">
          <div className="model-actions">
            <button
              className="asset-link button-link"
              type="button"
              onClick={handleLoadLatestLocalModel}
              disabled={isLoadingLatestModel || isLoadingLocalTasks}
            >
              {isLoadingLatestModel ? <LoaderCircle size={18} className="spin" /> : <Box size={18} />}
              <span>Load latest model</span>
            </button>
            <button
              className="asset-link button-link"
              type="button"
              onClick={refreshLocalTasks}
              disabled={isLoadingLocalTasks}
            >
              {isLoadingLocalTasks ? <LoaderCircle size={18} className="spin" /> : <RadioTower size={18} />}
              <span>Refresh list</span>
            </button>
          </div>
          {localTasks.length ? (
            <div className="local-model-list">
              {localTasks.map((localTask) => {
                const code = localTask.status?.code
                const complete = isNodeOdmComplete(code)
                const loading = loadingLocalTaskUuid === localTask.uuid
                const active = activeLocalTaskUuid === localTask.uuid

                return (
                  <div
                    key={localTask.uuid}
                    className="local-model-row"
                    data-active={active ? 'true' : undefined}
                    data-complete={complete ? 'true' : undefined}
                  >
                    <div>
                      <strong>{localTask.name || `Task ${shortUuid(localTask.uuid)}`}</strong>
                      <span>
                        {nodeOdmStatusLabel(code)} / {localTask.imagesCount ?? '-'} images / {localTask.progress ?? 0}%
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => loadLocalModel(localTask.uuid, localTask)}
                      disabled={!complete || loading}
                      title={complete ? 'Load model preview' : 'Task is not complete yet'}
                    >
                      {loading ? <LoaderCircle size={16} className="spin" /> : <Box size={16} />}
                      <span>{active ? 'Loaded' : 'Load'}</span>
                    </button>
                  </div>
                )
              })}
            </div>
          ) : null}
          {localModelUrl ? (
            <a key="local-model" className="asset-link" href={localModelUrl} target="_blank" rel="noreferrer">
              <Download size={18} />
              <span>Download preview GLB</span>
            </a>
          ) : null}
          {selectedAssets.length ? (
            selectedAssets.map((asset) => (
              <a key={asset} className="asset-link" href={downloadUrl(asset)} target="_blank" rel="noreferrer">
                <Download size={18} />
                <span>{assetLabels[asset]}</span>
              </a>
            ))
          ) : !localModelUrl ? (
            <div className="empty-state">
              <Download size={22} />
              <span>Assets appear after completion</span>
            </div>
          ) : null}
          {localTaskInfo ? (
            <div className="local-task-note">
              <span>{localTaskInfo.imagesCount ?? '-'} images</span>
              <span>{localTaskInfo.progress ?? 100}% complete</span>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  )
}

export default App
