import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { FollowerHistoryRow } from '../../types'
import { Room } from '../Room'

const fmtNum = (n: number) => n.toLocaleString()

export function MarketRoom({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<FollowerHistoryRow[]>([])

  useEffect(() => {
    api.analyticsFollowers().then(setRows)
  }, [])

  // Show the most recent 60 days (avoid a very long table)
  const recent = rows.slice(-60)

  return (
    <Room title="Lookout — Follower Analytics" icon="📊" onClose={onClose}>
      {rows.length === 0 ? (
        <p className="text-[#5b3a1a]/70">
          No follower data yet. Upload a FollowerHistory.csv to see the growth chart here.
        </p>
      ) : (
        <>
          <p className="mb-3 text-xs text-[#5b3a1a]/60">
            Showing last {recent.length} days · {rows.length} total rows
          </p>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-[#5b3a1a]/80">
              <tr>
                <th className="py-1">Date</th>
                <th className="py-1 text-right">Followers</th>
                <th className="py-1 text-right">Change</th>
              </tr>
            </thead>
            <tbody>
              {[...recent].reverse().map((r) => (
                <tr key={r.date} className="border-t border-[#5b3a1a]/15">
                  <td className="py-1.5">{r.date}</td>
                  <td className="py-1.5 text-right tabular-nums">{fmtNum(r.followers)}</td>
                  <td
                    className={`py-1.5 text-right tabular-nums ${
                      r.net_change > 0
                        ? 'text-green-700'
                        : r.net_change < 0
                          ? 'text-red-600'
                          : 'text-zinc-400'
                    }`}
                  >
                    {r.net_change > 0 ? '+' : ''}
                    {r.net_change}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </Room>
  )
}
