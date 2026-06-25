import { useEffect, useState } from 'react'
import { api } from '../../api'
import type { VideoRow } from '../../types'
import { Room } from '../Room'

const fmtNum = (n: number) => n.toLocaleString()
const fmtPct = (r: number) => `${(r * 100).toFixed(2)}%`

export function CatalogRoom({ onClose }: { onClose: () => void }) {
  const [videos, setVideos] = useState<VideoRow[]>([])

  useEffect(() => {
    api.analyticsContent().then(setVideos)
  }, [])

  return (
    <Room title="Warehouse — Content Catalog" icon="🎬" onClose={onClose}>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-[#5b3a1a]/80">
          <tr>
            <th className="py-1">Title</th>
            <th className="py-1 text-right">Posted</th>
            <th className="py-1 text-right">Views</th>
            <th className="py-1 text-right">Engagement</th>
          </tr>
        </thead>
        <tbody>
          {videos.map((v) => (
            <tr key={v.video_id} className="border-t border-[#5b3a1a]/15">
              <td className="py-1.5">
                <a
                  href={v.video_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {v.video_title || v.video_id}
                </a>
              </td>
              <td className="py-1.5 text-right text-xs text-[#5b3a1a]/70">
                {v.post_date ?? '—'}
              </td>
              <td className="py-1.5 text-right tabular-nums">{fmtNum(v.views)}</td>
              <td className="py-1.5 text-right tabular-nums">{fmtPct(v.engagement_rate)}</td>
            </tr>
          ))}
          {videos.length === 0 && (
            <tr>
              <td colSpan={4} className="py-4 text-center text-[#5b3a1a]/60">
                No videos yet. Upload a Content.csv to see them here.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Room>
  )
}
