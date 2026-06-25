import { useEffect, useState } from 'react'
import { api } from '../api'
import type { PromptOut, RunOut } from '../types'

export function PromptCron() {
  const [prompts, setPrompts] = useState<PromptOut[]>([])
  const [runs, setRuns] = useState<RunOut[]>([])
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [schedule, setSchedule] = useState('every:2h')

  async function refresh() {
    setPrompts(await api.listPrompts())
    setRuns(await api.listRuns())
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data load on mount
    refresh().catch(() => {})
  }, [])

  async function create() {
    if (!name.trim() || !prompt.trim() || !schedule.trim()) return
    await api.createPrompt({ name, prompt, schedule })
    setName('')
    setPrompt('')
    await refresh()
  }

  async function toggle(p: PromptOut) {
    await api.updatePrompt(p.id, { ...p, enabled: !p.enabled })
    await refresh()
  }

  async function remove(id: number) {
    await api.deletePrompt(id)
    await refresh()
  }

  return (
    <div className="flex h-full flex-col overflow-auto p-3 text-sm">
      <div className="space-y-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Name"
          className="w-full rounded bg-white/5 px-2 py-1.5 outline-none"
        />
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Your prompt (any text), e.g. summarize today's sales and flag the top product"
          rows={3}
          className="w-full rounded bg-white/5 px-2 py-1.5 outline-none"
        />
        <input
          value={schedule}
          onChange={(e) => setSchedule(e.target.value)}
          placeholder="Schedule: every:2h | daily:07:00 | */5 * * * *"
          className="w-full rounded bg-white/5 px-2 py-1.5 font-mono text-xs outline-none"
        />
        <button
          onClick={create}
          className="w-full rounded bg-amber-500 py-1.5 font-medium text-black"
        >
          Add prompt-cron
        </button>
      </div>

      <h3 className="mt-4 mb-1 text-xs tracking-widest text-zinc-400">SCHEDULED</h3>
      <ul className="space-y-1">
        {prompts.map((p) => (
          <li key={p.id} className="rounded bg-white/5 p-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{p.name}</span>
              <span className="flex gap-2 text-xs">
                <button onClick={() => toggle(p)} className="text-amber-300">
                  {p.enabled ? 'on' : 'off'}
                </button>
                <button onClick={() => remove(p.id)} className="text-zinc-400">
                  del
                </button>
              </span>
            </div>
            <div className="font-mono text-[11px] text-zinc-400">{p.schedule}</div>
          </li>
        ))}
        {prompts.length === 0 && <li className="text-zinc-500">None yet.</li>}
      </ul>

      <h3 className="mt-4 mb-1 text-xs tracking-widest text-zinc-400">RUN HISTORY</h3>
      <ul className="space-y-1">
        {runs.map((r) => (
          <li key={r.id} className="rounded bg-white/5 p-2">
            <div className="flex justify-between text-xs text-zinc-400">
              <span>#{r.id}</span>
              <span>{r.status}</span>
            </div>
            <div className="text-zinc-200">{r.output ?? r.error ?? '—'}</div>
          </li>
        ))}
        {runs.length === 0 && <li className="text-zinc-500">No runs yet.</li>}
      </ul>
    </div>
  )
}
