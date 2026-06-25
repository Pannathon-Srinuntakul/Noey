/* eslint-disable react-hooks/immutability -- R3F mutates three.js objects (uniforms, materials) by design */
/* eslint-disable react-hooks/purity -- seed via useRef is intentionally impure once */
import { Canvas, useFrame } from '@react-three/fiber'
import { Environment, Html, OrbitControls } from '@react-three/drei'
import { Suspense, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { useGLTF } from '@react-three/drei'

// ── Config types ────────────────────────────────────────────────────────────

export interface Placed {
  url: string
  /** Normalized world height in "meters"; model is scaled so its bbox height matches. */
  height: number
  position: [number, number, number]
  rotation?: number
  /** Override colour (multiplies the model's texture/material). */
  tint?: string
}

export interface Hotspot extends Placed {
  id: string
  label: string
  /** Label height above the object base. Defaults to object height + 0.4 */
  labelY?: number
}

export interface RoomPalette {
  bg: string
  floor: string
  floorPlank: string
  wall: string
  ceiling: string
  beam: string
}

export interface RoomConfig {
  dims: { W: number; D: number; H: number }
  palette: RoomPalette
  ambient: number
  /** warm light sources (candles/lamps) — flicker subtly */
  lights: { position: [number, number, number]; color: string; intensity: number }[]
  /** environment preset for soft reflections */
  envPreset?: 'apartment' | 'warehouse' | 'city' | 'sunset' | 'dawn' | 'night' | 'studio'
  camera: { position: [number, number, number]; target: [number, number, number] }
  furniture: Placed[]
  hotspots: Hotspot[]
  /** Default tint applied to every furniture/hotspot model unless the item overrides it. */
  tint?: string
}

// ── Normalized model loader ───────────────────────────────────────────────────

function useNormalized(url: string, height: number, tint?: string) {
  const { scene } = useGLTF(url)
  return useMemo(() => {
    const c = scene.clone(true)
    const box = new THREE.Box3().setFromObject(c)
    const size = box.getSize(new THREE.Vector3())
    const s = height / Math.max(size.y, 0.0001)
    c.scale.setScalar(s)
    // ground at y=0, centre x/z
    const box2 = new THREE.Box3().setFromObject(c)
    const ctr = box2.getCenter(new THREE.Vector3())
    c.position.x = -ctr.x
    c.position.z = -ctr.z
    c.position.y = -box2.min.y
    c.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        m.castShadow = true
        m.receiveShadow = true
        if (Array.isArray(m.material)) m.material = m.material.map((mm) => mm.clone())
        else m.material = (m.material as THREE.Material).clone()
        if (tint) {
          const mat = m.material as THREE.MeshStandardMaterial
          if (mat && 'color' in mat) mat.color = new THREE.Color(tint)
        }
      }
    })
    return c
  }, [scene, height, tint])
}

/** Global tint only applies to the pale furniture-kit models; native-textured props keep their look. */
function effectiveTint(url: string, itemTint?: string, globalTint?: string) {
  if (itemTint) return itemTint
  return url.includes('/furniture/') ? globalTint : undefined
}

function Decor({ item, tint }: { item: Placed; tint?: string }) {
  const obj = useNormalized(item.url, item.height, effectiveTint(item.url, item.tint, tint))
  return <primitive object={obj} position={item.position} rotation={[0, item.rotation ?? 0, 0]} />
}

function HotspotObject({
  spot,
  active,
  tint,
  onSelect,
}: {
  spot: Hotspot
  active: boolean
  tint?: string
  onSelect: (id: string) => void
}) {
  const obj = useNormalized(spot.url, spot.height, effectiveTint(spot.url, spot.tint, tint))
  const [hover, setHover] = useState(false)
  const group = useRef<THREE.Group>(null!)
  const glowLight = useRef<THREE.PointLight>(null!)
  const lit = hover || active

  // Collect emissive-capable materials once so useFrame never traverses the tree.
  const emissiveMats = useMemo(() => {
    const mats: THREE.MeshStandardMaterial[] = []
    obj.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.isMesh) {
        const mat = m.material as THREE.MeshStandardMaterial
        if (mat && 'emissive' in mat) {
          mat.emissive.set('#ffb733')
          mats.push(mat)
        }
      }
    })
    return mats
  }, [obj])

  useFrame((state) => {
    const t = state.clock.elapsedTime
    const pulse = 0.13 + Math.sin(t * 2) * 0.05
    const intensity = lit ? 0.6 : pulse
    for (const mat of emissiveMats) mat.emissiveIntensity = intensity
    if (glowLight.current) glowLight.current.intensity = lit ? 1.4 : 0.4 + Math.sin(t * 2) * 0.15
    if (group.current) {
      const target = lit ? 0.12 : 0
      group.current.position.y = THREE.MathUtils.lerp(group.current.position.y, target, 0.15)
      if (lit) group.current.position.y += Math.sin(t * 2.5) * 0.015
    }
  })

  const beaconY = spot.labelY ?? spot.height + 0.5

  return (
    <group position={spot.position}>
      {/* glow light hugging the object */}
      <pointLight ref={glowLight} position={[0, spot.height * 0.5, 0]} color="#ffc04d" intensity={0.4} distance={3} decay={2} />

      <group
        ref={group}
        onPointerOver={(e) => {
          e.stopPropagation()
          setHover(true)
          document.body.style.cursor = 'pointer'
        }}
        onPointerOut={() => {
          setHover(false)
          document.body.style.cursor = 'auto'
        }}
        onClick={(e) => {
          e.stopPropagation()
          onSelect(spot.id)
        }}
      >
        <primitive object={obj} rotation={[0, spot.rotation ?? 0, 0]} />
      </group>

      {/* floating beacon — always shown so the object reads as interactive */}
      <Html center position={[0, beaconY, 0]} distanceFactor={10} zIndexRange={[10, 0]}>
        <div
          onClick={() => onSelect(spot.id)}
          style={{
            whiteSpace: 'nowrap',
            padding: lit ? '5px 14px' : '4px 10px',
            borderRadius: 999,
            background: lit ? 'rgba(40,24,8,0.95)' : 'rgba(40,24,8,0.7)',
            color: '#ffe2a8',
            fontSize: lit ? 14 : 12,
            fontWeight: 600,
            letterSpacing: '0.04em',
            border: '1px solid rgba(255,200,100,0.5)',
            boxShadow: lit ? '0 0 18px rgba(255,180,60,0.6)' : '0 2px 10px rgba(0,0,0,0.4)',
            cursor: 'pointer',
            transition: 'all 0.18s ease',
            transform: lit ? 'scale(1.05)' : 'scale(1)',
          }}
        >
          {lit ? spot.label : `· ${spot.label}`}
        </div>
      </Html>
    </group>
  )
}

function Flicker({ light, primary }: { light: RoomConfig['lights'][number]; primary?: boolean }) {
  const ref = useRef<THREE.Light>(null!)
  const seed = useRef(Math.random() * 10).current
  useFrame((s) => {
    if (!ref.current) return
    const t = s.clock.elapsedTime + seed
    ref.current.intensity = light.intensity + Math.sin(t * 7.3) * 0.12 + Math.sin(t * 13.1) * 0.06
  })
  if (primary) {
    // SpotLight shadow = 1 scene render vs PointLight shadow = 6 (cube map faces).
    return (
      <spotLight
        ref={ref as React.Ref<THREE.SpotLight>}
        position={light.position}
        color={light.color}
        intensity={light.intensity}
        angle={0.7}
        penumbra={0.45}
        decay={2}
        distance={16}
        castShadow
        shadow-mapSize={[512, 512]}
        shadow-bias={-0.002}
      />
    )
  }
  return (
    <pointLight
      ref={ref as React.Ref<THREE.PointLight>}
      position={light.position}
      color={light.color}
      intensity={light.intensity}
      decay={2}
      distance={16}
    />
  )
}

function Shell({ cfg }: { cfg: RoomConfig }) {
  const { W, D, H } = cfg.dims
  const p = cfg.palette
  const mat = (color: string, rough = 0.8) =>
    new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 })

  const floorMat = useMemo(() => mat(p.floor, 0.9), [p.floor])
  const wallMat = useMemo(() => mat(p.wall, 0.75), [p.wall])
  const ceilMat = useMemo(() => mat(p.ceiling, 0.8), [p.ceiling])
  const beamMat = useMemo(() => mat(p.beam, 0.9), [p.beam])
  const plankMat = useMemo(() => mat(p.floorPlank, 0.9), [p.floorPlank])

  const planks = []
  for (let x = -W / 2 + 1; x < W / 2; x += 1.2) planks.push(x)

  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} material={floorMat} receiveShadow>
        <planeGeometry args={[W, D]} />
      </mesh>
      {planks.map((x) => (
        <mesh key={x} rotation={[-Math.PI / 2, 0, 0]} position={[x, 0.006, 0]} material={plankMat}>
          <planeGeometry args={[0.05, D]} />
        </mesh>
      ))}

      <mesh position={[0, H / 2, -D / 2]} material={wallMat} receiveShadow castShadow>
        <boxGeometry args={[W, H, 0.14]} />
      </mesh>
      <mesh position={[-W / 2, H / 2, 0]} material={wallMat} receiveShadow castShadow>
        <boxGeometry args={[0.14, H, D]} />
      </mesh>
      <mesh position={[W / 2, H / 2, 0]} material={wallMat} receiveShadow castShadow>
        <boxGeometry args={[0.14, H, D]} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, H, 0]} material={ceilMat} receiveShadow>
        <planeGeometry args={[W, D]} />
      </mesh>

      {/* ceiling beams */}
      {[-W / 4, 0, W / 4].map((x) => (
        <mesh key={x} position={[x, H - 0.13, 0]} material={beamMat} castShadow>
          <boxGeometry args={[0.2, 0.26, D]} />
        </mesh>
      ))}

      {/* skirting */}
      <mesh position={[0, 0.11, -D / 2 + 0.08]} material={beamMat}>
        <boxGeometry args={[W, 0.22, 0.07]} />
      </mesh>
      <mesh position={[-W / 2 + 0.08, 0.11, 0]} material={beamMat}>
        <boxGeometry args={[0.07, 0.22, D]} />
      </mesh>
      <mesh position={[W / 2 - 0.08, 0.11, 0]} material={beamMat}>
        <boxGeometry args={[0.07, 0.22, D]} />
      </mesh>
    </group>
  )
}

export function InteractiveRoom({
  config,
  active,
  onSelect,
}: {
  config: RoomConfig
  active: string | null
  onSelect: (id: string | null) => void
}) {
  return (
    <Canvas
      shadows
      camera={{ position: config.camera.position, fov: 58 }}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
    >
      <color attach="background" args={[config.palette.bg]} />
      <fog attach="fog" args={[config.palette.bg, 9, 22]} />

      <ambientLight intensity={config.ambient} color="#ffe9cc" />
      {config.lights.map((l, i) => (
        <Flicker key={i} light={l} primary={i === 0} />
      ))}

      <Suspense fallback={null}>
        <Shell cfg={config} />
        {config.furniture.map((f, i) => (
          <Decor key={i} item={f} tint={config.tint} />
        ))}
        {config.hotspots.map((h) => (
          <HotspotObject key={h.id} spot={h} active={active === h.id} tint={config.tint} onSelect={onSelect} />
        ))}

        {config.envPreset && <Environment preset={config.envPreset} />}
      </Suspense>

      <OrbitControls
        target={config.camera.target}
        enablePan={false}
        enableDamping
        dampingFactor={0.08}
        minDistance={2.2}
        maxDistance={3.9}
        minPolarAngle={Math.PI * 0.3}
        maxPolarAngle={Math.PI * 0.5}
        minAzimuthAngle={-0.55}
        maxAzimuthAngle={0.55}
      />
    </Canvas>
  )
}
