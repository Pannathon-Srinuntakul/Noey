import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { SettingsOut } from '../../types'
import { Room } from '../Room'

export function SettingsRoom({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<SettingsOut | null>(null)
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    api.getSettings().then((d) => {
      setS(d)
      setModel(d.llm_model)
      setBaseUrl(d.llm_base_url ?? '')
    })
  }, [])

  async function save() {
    const d = await api.putSettings({ llm_model: model, llm_base_url: baseUrl })
    setS(d)
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <Room title="Workshop — Settings" icon="⚙️" onClose={onClose}>
      {!s ? (
        <p>Loading…</p>
      ) : (
        <div className="space-y-5">
          <section>
            <h3 className="mb-2 font-semibold">AI model</h3>
            <Field
              label="Model (e.g. anthropic/claude-sonnet-4-6, ollama/llama3)"
              value={model}
              onChange={setModel}
            />
            <Field
              label="Local base URL (optional, e.g. http://localhost:11434)"
              value={baseUrl}
              onChange={setBaseUrl}
            />
            <div className="mt-2 text-sm">
              API keys (from env):{' '}
              {Object.entries(s.keys).map(([k, v]) => (
                <span
                  key={k}
                  className={`mr-2 rounded px-1.5 py-0.5 ${
                    v ? 'bg-green-700/20 text-green-800' : 'bg-red-700/15 text-red-800'
                  }`}
                >
                  {k} {v ? '✓' : '✗'}
                </span>
              ))}
              <div className="mt-1 text-xs text-[#5b3a1a]/80">
                Keys live in <code>.env</code> (never stored in the DB).
              </div>
            </div>
          </section>

          <button
            onClick={save}
            className="rounded-lg bg-[#5b3a1a] px-4 py-2 font-medium text-amber-50"
          >
            {saved ? 'Saved ✓' : 'Save settings'}
          </button>
        </div>
      )}
    </Room>
  )
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label className="mb-2 block text-sm">
      <span className="mb-1 block text-[#5b3a1a]">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-[#5b3a1a]/40 bg-[#fffaf0] px-2 py-1.5 outline-none"
      />
    </label>
  )
}
