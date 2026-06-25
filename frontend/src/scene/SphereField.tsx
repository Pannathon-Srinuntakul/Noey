import { Instance, Instances } from '@react-three/drei'
import { useMemo, useState } from 'react'
import { SPHERE_CAP, engagementColor, gridPosition, sphereRadius } from '../lib/encoding'
import type { Entity } from '../types'

interface Props {
  entities: Entity[]
  onSelect: (e: Entity) => void
}

/** Instanced sphere field. size = views, color = engagement rate. Capped for perf. */
export function SphereField({ entities, onSelect }: Props) {
  const shown = entities.length > SPHERE_CAP ? entities.slice(0, SPHERE_CAP) : entities
  const maxViews = useMemo(() => Math.max(0, ...shown.map((e) => e.views)), [shown])

  return (
    <Instances limit={SPHERE_CAP} range={shown.length}>
      <sphereGeometry args={[1, 24, 24]} />
      <meshStandardMaterial roughness={0.45} metalness={0.1} />
      {shown.map((e, i) => (
        <Bubble
          key={e.id}
          entity={e}
          position={gridPosition(i, shown.length)}
          radius={sphereRadius(e.views, maxViews)}
          onSelect={onSelect}
        />
      ))}
    </Instances>
  )
}

function Bubble({
  entity,
  position,
  radius,
  onSelect,
}: {
  entity: Entity
  position: [number, number, number]
  radius: number
  onSelect: (e: Entity) => void
}) {
  const [hover, setHover] = useState(false)
  return (
    <Instance
      position={position}
      scale={hover ? radius * 1.18 : radius}
      color={engagementColor(entity.engagementRate)}
      onPointerOver={(ev) => {
        ev.stopPropagation()
        setHover(true)
      }}
      onPointerOut={() => setHover(false)}
      onClick={(ev) => {
        ev.stopPropagation()
        onSelect(entity)
      }}
    />
  )
}
