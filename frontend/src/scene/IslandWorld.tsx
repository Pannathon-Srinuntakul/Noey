/* eslint-disable react-hooks/immutability -- React Three Fiber mutates three.js objects
   (texture wrap flags, shader uniforms in useFrame) by design; this is idiomatic R3F. */
import {
  Cloud,
  Clouds,
  ContactShadows,
  Environment,
  Html,
  OrbitControls,
  useGLTF,
} from '@react-three/drei'
import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber'
import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import {
  Box3,
  MeshBasicMaterial,
  PlaneGeometry,
  RepeatWrapping,
  ShaderMaterial,
  TextureLoader,
  Vector3,
} from 'three'
import { Water } from 'three/examples/jsm/objects/Water.js'
import type { RoomName } from '../types'

/** Realistic ocean: three.js Water shader — sky/sun reflection + normal-map ripples. */
function RealisticOcean() {
  const waterNormals = useLoader(TextureLoader, '/textures/waternormals.jpg')
  waterNormals.wrapS = waterNormals.wrapT = RepeatWrapping

  const water = useMemo(() => {
    const geom = new PlaneGeometry(400, 400)
    return new Water(geom, {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals,
      sunDirection: new Vector3(0.7, 0.7, 0.0).normalize(),
      sunColor: 0xffffff,
      waterColor: 0x1fb6d6,
      distortionScale: 2.6,
      fog: true,
    })
  }, [waterNormals])

  useFrame((_, delta) => {
    ;(water.material as ShaderMaterial).uniforms.time.value += delta * 0.28
  })

  return <primitive object={water} rotation-x={-Math.PI / 2} position-y={0} />
}

/** Model normalized to a target world height and grounded (base at y=0), so every glb —
 * regardless of its source scale — sizes proportionally to the others. */
function SizedModel({
  url,
  height,
  ...props
}: { url: string; height: number } & React.ComponentProps<'group'>) {
  const { scene } = useGLTF(url)
  const obj = useMemo(() => {
    const clone = scene.clone()
    const box = new Box3().setFromObject(clone)
    const size = new Vector3()
    box.getSize(size)
    const s = size.y > 0 ? height / size.y : 1
    clone.scale.setScalar(s)
    const grounded = new Box3().setFromObject(clone)
    const center = new Vector3()
    grounded.getCenter(center)
    clone.position.x -= center.x
    clone.position.z -= center.z
    clone.position.y -= grounded.min.y // base sits on the ground
    clone.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (mesh.isMesh) { mesh.castShadow = true; mesh.receiveShadow = true }
    })
    return clone
  }, [scene, height])
  return <primitive object={obj} {...props} />
}

/** A clickable landmark with hover lift + cursor.
 * A static invisible hitbox keeps the pointer stable so the hover lift doesn't make us
 * lose hover and flicker. */
function Landmark({
  children,
  onClick,
  label,
  position = [0, 0, 0],
  hitbox,
}: {
  children: React.ReactNode
  onClick?: () => void
  label?: string
  position?: [number, number, number]
  hitbox?: [number, number, number]
}) {
  const [hover, setHover] = useState(false)
  return (
    <group
      position={position}
      onPointerOver={(e) => {
        e.stopPropagation()
        setHover(true)
        document.body.style.cursor = onClick ? 'pointer' : 'default'
      }}
      onPointerOut={() => {
        setHover(false)
        document.body.style.cursor = 'default'
      }}
      onClick={
        onClick
          ? (e) => {
              e.stopPropagation()
              onClick()
            }
          : undefined
      }
    >
      {/* stable hit area (covers the model even while it lifts) */}
      {onClick && hitbox && (
        <mesh position={[0, hitbox[1] / 2, 0]}>
          <boxGeometry args={hitbox} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
      <group position-y={hover && onClick ? 0.18 : 0}>{children}</group>
      {hover && label && (
        <Html center distanceFactor={10} position={[0, 1.7, 0]}>
          <div className="whitespace-nowrap rounded-md border border-white/15 bg-black/80 px-2 py-1 text-xs text-amber-200 backdrop-blur">
            {label}
          </div>
        </Html>
      )}
    </group>
  )
}

const CAM_KEY = 'noey-island-cam'

/** Saves camera position/target to sessionStorage on change; restores on mount. */
function CameraStateSync() {
  const { camera } = useThree()
  const controlsRef = useRef<{ target: THREE.Vector3 } | null>(null)
  const dirty = useRef(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Restore saved state once on mount
  useEffect(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(CAM_KEY) ?? 'null')
      if (saved?.position && saved?.target) {
        camera.position.fromArray(saved.position)
      }
    } catch { /* ignore */ }
  }, [camera])

  useFrame((state) => {
    // Grab controls target via state.controls (set by OrbitControls)
    const ctrl = state.controls as { target?: THREE.Vector3 } | null
    if (ctrl?.target) controlsRef.current = ctrl as { target: THREE.Vector3 }

    if (!dirty.current) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      dirty.current = false
      try {
        sessionStorage.setItem(CAM_KEY, JSON.stringify({
          position: camera.position.toArray(),
          target: controlsRef.current?.target.toArray() ?? [0, 0, 0],
        }))
      } catch { /* ignore */ }
    }, 300)
    dirty.current = false
  })

  // Mark dirty on any pointer move (camera orbit)
  useEffect(() => {
    const mark = () => { dirty.current = true }
    window.addEventListener('pointermove', mark)
    window.addEventListener('wheel', mark)
    return () => {
      window.removeEventListener('pointermove', mark)
      window.removeEventListener('wheel', mark)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return null
}

interface Props {
  activity: number
  onSelectChest: () => void
  onOpenRoom: (room: RoomName) => void
}

export function IslandWorld({ activity, onSelectChest, onOpenRoom }: Props) {
  return (
    <Canvas camera={{ position: [17, 14, 20], fov: 44 }} shadows dpr={[1, 1.5]}>
      <color attach="background" args={['#8ed6f5']} />
      <fog attach="fog" args={['#a7e2fb', 34, 110]} />

      <ambientLight intensity={0.85} />
      <directionalLight position={[6, 10, 4]} intensity={1.9} castShadow shadow-mapSize={[1024, 1024]} />
      <Suspense fallback={<Html center><span className="text-zinc-400">Loading island…</span></Html>}>
        <Environment preset="park" />

        {/* distant sky clouds — high + far so they read as a backdrop, not in-scene */}
        <Clouds material={MeshBasicMaterial}>
          <Cloud seed={1} segments={34} bounds={[16, 2, 16]} volume={12} opacity={0.85} color="#ffffff" position={[-28, 17, -36]} speed={0.06} />
          <Cloud seed={2} segments={30} bounds={[16, 2, 16]} volume={11} opacity={0.8} color="#eef8ff" position={[26, 19, -40]} speed={0.05} />
          <Cloud seed={3} segments={28} bounds={[14, 2, 14]} volume={10} opacity={0.75} color="#ffffff" position={[0, 22, -48]} speed={0.04} />
          <Cloud seed={4} segments={26} bounds={[14, 2, 14]} volume={10} opacity={0.7} color="#f2faff" position={[-34, 15, -16]} speed={0.04} />
        </Clouds>

        {/* realistic ocean + foam ring at the shoreline */}
        <RealisticOcean />
        <mesh rotation-x={-Math.PI / 2} position-y={0.12}>
          <ringGeometry args={[5.3, 6.0, 8]} />
          <meshBasicMaterial color="#cdeeff" transparent opacity={0.4} />
        </mesh>

        {/* procedural low-poly island: dirt + sand rim + grass top */}
        <group>
          <mesh position-y={-0.7} castShadow receiveShadow>
            <cylinderGeometry args={[5.3, 4.1, 2.0, 8]} />
            <meshStandardMaterial color="#7a4a24" flatShading roughness={1} />
          </mesh>
          <mesh position-y={0.18}>
            <cylinderGeometry args={[5.7, 5.7, 0.2, 8]} />
            <meshStandardMaterial color="#e6cf8a" flatShading roughness={1} />
          </mesh>
          <mesh position-y={0.35} receiveShadow>
            <cylinderGeometry args={[5.2, 5.4, 0.34, 8]} />
            <meshStandardMaterial color="#5fa83d" flatShading roughness={1} />
          </mesh>
        </group>

        {/* account — lighthouse & keeper cottage (brighter with more runs) */}
        <Landmark
          label={`Account · ${activity} runs`}
          position={[-3.4, 0.5, -2.9]}
          onClick={() => onOpenRoom('account')}
          hitbox={[2.2, 6.4, 2.2]}
        >
          <SizedModel url="/models/lighthouse.glb" height={6} />
          <pointLight
            position={[0, 2.5, 0]}
            intensity={Math.min(0.6 + activity * 0.06, 3)}
            color="#ffd76a"
            distance={9}
          />
        </Landmark>

        {/* top videos — treasure chest, clickable */}
        <Landmark
          label="Top Videos — click to open"
          onClick={onSelectChest}
          position={[3.6, 0.5, 2.8]}
          hitbox={[1.4, 1.3, 1.4]}
        >
          <SizedModel url="/models/chest.glb" height={0.7} />
          {/* warm glow from the open chest */}
          <pointLight position={[0, 0.4, 0]} intensity={0.6} color="#ffcf5a" distance={2} />
        </Landmark>

        {/* settings — workshop hut */}
        <Landmark
          label="Settings"
          position={[1.2, 0.5, 3.2]}
          onClick={() => onOpenRoom('settings')}
          hitbox={[2, 1.8, 2]}
        >
          <SizedModel url="/models/hut.glb" height={1.1} />
        </Landmark>

        {/* catalog — warehouse */}
        <Landmark
          label="Catalog"
          position={[-4.3, 0.5, 0.8]}
          onClick={() => onOpenRoom('catalog')}
          hitbox={[2.4, 2, 2.4]}
        >
          <SizedModel url="/models/house.glb" height={1.5} />
        </Landmark>

        {/* market — lookout stall */}
        <Landmark
          label="Market"
          position={[2.9, 0.5, -3.6]}
          onClick={() => onOpenRoom('market')}
          hitbox={[2.4, 1.9, 2.4]}
        >
          <SizedModel url="/models/barracks.glb" height={1.3} />
        </Landmark>

        {/* tables — town hall (centre of the island) */}
        <Landmark
          label="ตารางข้อมูล"
          position={[-0.3, 0.5, -0.4]}
          onClick={() => onOpenRoom('tables')}
          hitbox={[2.4, 2.2, 2.4]}
        >
          <SizedModel url="/models/town_hall.glb" height={1.7} />
        </Landmark>

        {/* palms decor */}
        <SizedModel url="/models/palm.glb" height={2.2} position={[4.4, 0.5, -0.8]} />
        <SizedModel url="/models/palm.glb" height={1.9} position={[-1.4, 0.5, 4.3]} rotation-y={1.2} />
        <SizedModel url="/models/palm.glb" height={2.0} position={[-3.6, 0.5, 3.2]} rotation-y={2.4} />

        <ContactShadows position={[0, 0.53, 0]} opacity={0.45} scale={17} blur={1.8} far={4} frames={1} />
      </Suspense>

      <OrbitControls
        enablePan={false}
        minDistance={5}
        maxDistance={22}
        maxPolarAngle={Math.PI / 2.15}
        enableDamping
        makeDefault
      />
      <CameraStateSync />
    </Canvas>
  )
}

useGLTF.preload('/models/lighthouse.glb')
useGLTF.preload('/models/chest.glb')
useGLTF.preload('/models/palm.glb')
useGLTF.preload('/models/hut.glb')
useGLTF.preload('/models/house.glb')
useGLTF.preload('/models/barracks.glb')
useGLTF.preload('/models/town_hall.glb')
