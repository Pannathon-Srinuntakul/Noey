import { OrbitControls } from '@react-three/drei'
import { Canvas } from '@react-three/fiber'
import type { Entity } from '../types'
import { DrillCard } from './DrillCard'
import { SphereField } from './SphereField'

interface Props {
  entities: Entity[]
  selected: Entity | null
  onSelect: (e: Entity | null) => void
}

/** The 3D data world. Camera is orbit + zoom only (no pan/free-fly) to keep UX simple. */
export function DataWorld({ entities, selected, onSelect }: Props) {
  return (
    <Canvas camera={{ position: [10, 8, 14], fov: 50 }} onPointerMissed={() => onSelect(null)}>
      <color attach="background" args={['#07080d']} />
      <ambientLight intensity={0.6} />
      <pointLight position={[15, 20, 12]} intensity={1.2} />
      <pointLight position={[-12, -8, -10]} intensity={0.4} color="#6ea8ff" />

      <SphereField entities={entities} onSelect={onSelect} />
      {selected && <DrillCard entity={selected} onClose={() => onSelect(null)} />}

      <OrbitControls
        enablePan={false}
        minDistance={6}
        maxDistance={45}
        enableDamping
        dampingFactor={0.08}
      />
    </Canvas>
  )
}
