/* eslint-disable react-hooks/set-state-in-effect -- fetch-on-mount/change loads */
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowLeft, GripVertical, Settings2, Table2, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, formatUserError } from '../api'
import { ConfirmModal } from '../hud/ConfirmModal'
import { useNavigateWithDoor } from '../navigation/NavigationContext'
import { TableEditor } from '../hud/TableEditor'
import type { CustomTableOut } from '../types'

export default function TablePage() {
  const { navigateWithDoor } = useNavigateWithDoor()
  const navigate = useNavigate()
  const { id: urlId } = useParams<{ id?: string }>()
  const activeId = urlId ?? null   // uid string (UUID) or null

  const [tables, setTables] = useState<CustomTableOut[]>([])
  const [active, setActive] = useState<CustomTableOut | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const loadList = useCallback(() => {
    api.tables
      .list()
      .then((list) => {
        setTables(list)
        // Auto-open first table if no id in URL
        if (!urlId && list.length > 0) {
          navigate(`/tables/${list[0].uid}`, { replace: true })
        }
      })
      .catch((e) => setError(formatUserError(e)))
  }, [urlId, navigate])

  useEffect(() => { loadList() }, [loadList])

  const loadActive = useCallback((uid: string) => {
    api.tables
      .get(uid)
      .then(setActive)
      .catch((e) => setError(formatUserError(e)))
  }, [])

  useEffect(() => {
    if (activeId == null) {
      setActive(null)
      return
    }
    loadActive(activeId)
  }, [activeId, loadActive])

  function openTable(uid: string) {
    navigate(`/tables/${uid}`)
  }

  async function doDeleteTable(uid: string) {
    setConfirmDelete(null)
    try {
      await api.tables.delete(uid)
      if (activeId === uid) navigate('/tables', { replace: true })
      loadList()
    } catch (e) {
      setError(formatUserError(e))
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active: dragActive, over } = event
    if (!over || dragActive.id === over.id) return

    const oldIndex = tables.findIndex((t) => t.uid === String(dragActive.id))
    const newIndex = tables.findIndex((t) => t.uid === String(over.id))
    if (oldIndex < 0 || newIndex < 0) return

    const reordered = [...tables]
    const [moved] = reordered.splice(oldIndex, 1)
    reordered.splice(newIndex, 0, moved)
    setTables(reordered)  // optimistic

    try {
      await api.tables.reorder(reordered.map((t) => t.uid))
    } catch (e) {
      loadList()  // revert on error
      setError(formatUserError(e))
    }
  }

  return (
    <div className="scroll-light flex h-full w-full bg-zinc-100">
      {/* sidebar */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-zinc-200 bg-white">
        <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-3">
          <button
            onClick={() => navigateWithDoor('/')}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-zinc-500 hover:bg-zinc-100"
          >
            <ArrowLeft size={14} /> เกาะ
          </button>
          <span className="flex items-center gap-1.5 text-sm font-bold text-zinc-700">
            <Table2 size={15} /> ตารางข้อมูล
          </span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={tables.map((t) => t.uid)} strategy={verticalListSortingStrategy}>
              {tables.map((t) => (
                <SortableTableItem
                  key={t.uid}
                  table={t}
                  active={activeId === t.uid}
                  onOpen={() => openTable(t.uid)}
                  onDelete={() => setConfirmDelete(t.uid)}
                />
              ))}
            </SortableContext>
          </DndContext>
          {tables.length === 0 && (
            <p className="px-2 py-3 text-xs text-zinc-400">ยังไม่มีตาราง</p>
          )}
        </div>

        <div className="border-t border-zinc-200 p-2">
          <button
            onClick={() => navigate('/tables/create')}
            className="w-full rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white shadow hover:bg-amber-700"
          >
            + สร้างตารางใหม่
          </button>
        </div>
      </aside>

      {/* main */}
      <main className="min-w-0 flex-1">
        {error && (
          <div className="flex items-center justify-between bg-red-50 px-4 py-2 text-sm text-red-700">
            <span>{error}</span>
            <button onClick={() => setError(null)}>✕</button>
          </div>
        )}

        {active ? (
          <div className="flex h-full flex-col">
            <div className="flex items-center gap-2 border-b border-zinc-200 bg-white px-4 py-2">
              <TableTitle
                key={active.uid}
                table={active}
                onRename={async (name) => {
                  await api.tables.rename(active.uid, name)
                  loadList()
                  loadActive(active.uid)
                }}
              />
              <button
                onClick={() => navigate(`/tables/edit/${active.uid}`)}
                className="ml-auto flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-500 hover:bg-zinc-50 hover:text-zinc-700"
                title="จัดการ Columns"
              >
                <Settings2 size={14} /> จัดการ Columns
              </button>
            </div>
            <div className="min-h-0 flex-1 bg-white">
              <TableEditor table={active} onColumnsChanged={() => loadActive(active.uid)} />
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-zinc-400">
            เลือกตารางจากด้านซ้าย หรือสร้างตารางใหม่
          </div>
        )}
      </main>

      {confirmDelete != null && (
        <ConfirmModal
          title="ลบตาราง"
          message="ข้อมูลทั้งหมดในตารางจะถูกลบถาวร ไม่สามารถกู้คืนได้"
          confirmLabel="ลบถาวร"
          onConfirm={() => doDeleteTable(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  )
}

function SortableTableItem({
  table,
  active,
  onOpen,
  onDelete,
}: {
  table: CustomTableOut
  active: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: table.uid,
  })
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-center rounded-lg px-1 py-1.5 text-sm transition ${
        active ? 'bg-amber-100 font-medium text-amber-900' : 'text-zinc-700 hover:bg-zinc-100'
      }`}
    >
      {/* drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="mr-1 cursor-grab text-zinc-400 opacity-0 transition group-hover:opacity-100 active:cursor-grabbing"
        title="ลากเพื่อเรียงลำดับ"
      >
        <GripVertical size={14} />
      </button>
      <button onClick={onOpen} className="min-w-0 flex-1 truncate text-left">
        {table.display_name}
      </button>
      <button
        onClick={onDelete}
        title="ลบตาราง"
        className="ml-1 text-zinc-400 opacity-0 transition hover:text-red-500 group-hover:opacity-100"
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

function TableTitle({
  table,
  onRename,
}: {
  table: CustomTableOut
  onRename: (name: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(table.display_name)

  if (editing) {
    return (
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => {
          setEditing(false)
          if (name.trim() && name !== table.display_name) onRename(name.trim())
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        className="rounded border border-amber-400 px-2 py-1 text-lg font-bold text-zinc-800 outline-none"
      />
    )
  }
  return (
    <button
      onClick={() => setEditing(true)}
      title="คลิกเพื่อแก้ชื่อ"
      className="text-lg font-bold text-zinc-800 hover:text-amber-700"
    >
      {table.display_name}
    </button>
  )
}
