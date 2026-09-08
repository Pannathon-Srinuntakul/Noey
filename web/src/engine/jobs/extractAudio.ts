/**
 * `extract-audio` — the speech WAVs the transcriber is given.
 *
 * Mirrors `desktop/sidecar/sidecar/audio.py:run_extract_audio`. The file NAMES
 * are part of the contract, not a detail: the backend validates them against
 * `^audio_\d{3}\.wav$` and 422s anything else.
 *
 * A clip with no audio track is a hard error, the same as on the desktop —
 * these modes are built on what is being said, so a silent clip is a mistake
 * to report, not a file to transcribe into nothing.
 */

import {
  listProjectDir,
  listDir,
  projectFilePath,
  writeFileAtomic,
  deleteFile
} from '../../platform/fs'
import type { SidecarEvent } from '../../platform/types'
import { extractSpeechWav } from '../audio'
import { probeSource } from '../media'
import { registerJob, type ProgressCallback } from '../index'
import { signalOf, throwIfAborted } from '../abort'
import { blobForPath } from './probe'

registerJob('extract-audio', async (job, emit: ProgressCallback): Promise<SidecarEvent> => {
  const uid = String(job.projectDir ?? '')
    .split('/')
    .pop() as string

  // `listProjectDir`, not `listDir`: on a project opened in another browser the
  // normalized clips are on the server and the local store is empty, and this
  // used to answer "run ingest first" for a project that had been imported
  // days ago. `blobForPath` below fetches whichever copy exists.
  const normalized = (await listProjectDir(uid, 'normalized'))
    .filter((e) => e.kind === 'file' && e.name.startsWith('norm_'))
    .sort((a, b) => a.name.localeCompare(b.name))
  if (normalized.length === 0) throw new Error('no normalized clips — run ingest first')

  // Stale WAVs from an earlier run would be uploaded alongside the new ones.
  for (const stale of await listDir(projectFilePath(uid, 'audio'))) {
    if (stale.name.endsWith('.wav')) await deleteFile(projectFilePath(uid, `audio/${stale.name}`))
  }

  const wavs: { file: string; name: string; bytes: number }[] = []
  const signal = signalOf(job)
  for (let i = 0; i < normalized.length; i++) {
    throwIfAborted(signal)
    const entry = normalized[i]
    emit({
      event: 'progress',
      stage: 'audio',
      step: i + 1,
      total: normalized.length,
      message: entry.name
    })
    const source = await blobForPath(projectFilePath(uid, `normalized/${entry.name}`))
    const info = await probeSource(source)
    if (!info.hasAudio) {
      throw new Error(`คลิป ${entry.name} ไม่มีเสียง — โหมดนี้ต้องมีเสียงพูดในวิดีโอ`)
    }
    const wav = await extractSpeechWav(source)
    const name = `audio_${String(i).padStart(3, '0')}.wav`
    await writeFileAtomic(projectFilePath(uid, `audio/${name}`), wav)
    wavs.push({ file: `audio/${name}`, name, bytes: wav.byteLength })
  }

  return { event: 'done', wavs }
})
