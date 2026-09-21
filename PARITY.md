# Web ↔ Desktop parity

The two clients are one product. This file is the ledger of everything that
exists on one side and not the other, so a gap is never carried by memory alone.

**Rule (CLAUDE.md #8):** when a feature, fix or behaviour change lands on ONE
side only, add a row here in the same session. Remove the row when the other
side catches up.

**Not a parity gap:** something deliberately hidden on a side because that side
cannot support it yet (a browser API that does not exist, a native capability
the web has no access to). That is a platform limit. Those live in "Platform
limits" at the bottom, which is a reference, not a to-do list.

---

## Open gaps — work that could exist on both and currently does not

| What | Has it | Missing | Why it happened |
|---|---|---|---|
| Sequential decode (`framesAt`) in `extract-proxy` / `filmstrip` / music re-encode — 13× faster, byte-identical output | web | desktop (n/a — ffmpeg already sequential) | Web-only defect from the port; the desktop sidecar never had it. No action needed. |
| Persisted activity log + Settings → บันทึกการทำงาน (lifecycle trace, engine heartbeat, wake-lock result) | web | desktop | Built to diagnose iOS render stalls. The desktop writes `userData/logs/app.log` and has a console, so the need is weaker — but the lifecycle/heartbeat lines would still help there. |
| `mobile-probe.js` — collapse/starvation/reachability harness | web | n/a | Browser-only concern. |
| Caption preview thumb falls back to the server poster frame for undecodable (HEVC) sources | web | n/a | Desktop decodes HEVC locally; no gap. |
| Transcode download resume + retry-safe DELETE | web | n/a | Server transcode exists only on web. |
| No-target cut length: prompt anchor removed (25–35s band), footage-scaled wording, NO_VO length policy | shared backend | — | Fixes both clients at once; no gap. |
| Editor keeps AI shot metadata (`alternates`, `matchedFrameTime`, `visualDescription`) through every save — `EditCut.meta`, `editCutsFromDubSegments` / `dubSegmentsFromEditCuts`, `cutPayload`, `splitCutAt` second half without it | web | desktop | 2026-09-21: autosave emptied ปรับช็อต after any editor visit. Desktop's `lib/dubSegments.ts` / `lib/editorApi.ts` / `TimelineEditor.tsx` have the same loss. Fixed on web only because this machine's desktop tree is partial (gitignored; no `timelineMath.ts`, `ProjectDetailPage`, `jobs.tsx`). |
| Editor way out: leaves at once (draft finishes behind it), no "unsaved" dialog; `LocalProject.needsRender` / `renderedSig` + notice on the project page instead; draft written locally first, server copy pushed in order in the background; autosave 800ms | web | desktop | 2026-09-21 live report: back button dead for up to a minute, "not saved" warning while the draft was already saved. Same design on desktop (`requestClose` awaits the draft). |
| Undo/redo history survives leaving the editor for the session (`keepHistory` / `takeHistory` in `lib/editorHistory.ts`) | web | desktop | 2026-09-21: "กลับมาแล้ว undo ไม่ได้". |
| Left-trim keeps the handle under the pointer (lane scrolls by the growth, CapCut-style), preview seeks to the trimmed edge, half-viewport tail; playhead line drawn above trim handles; rAF-coalesced trim + scrub; memoized per-block offsets | web | desktop | 2026-09-21: "ยืดไปด้านหลังแล้วช็อตเดินหน้า", playhead hidden under the gold handles, drags lagging. Desktop `TimelineEditor.tsx` is identical code. |
| ปรับช็อต → ทำคลิปใหม่ goes straight to the progress screen and shows busy immediately; terminal `local-status` PATCH retried in the background instead of failing a finished render; "HTTP 0" mapped to the Thai network message (`responseErrorDetail`) | web | desktop (swap UI + render path partly) | 2026-09-21: "กดทำคลิปใหม่แล้วไม่มีอะไรเกิดขึ้น … เจอ http 0". Desktop has no "HTTP 0" (its proxy rethrows) but has the same uncaught terminal PATCH. |
| Filmstrip job cancelled when the editor closes (caller `signal` honoured by the engine) | web | n/a | Web engine only — the desktop sidecar is a separate process queue. |
| Fresh-browser restore lists projects as they arrive, skeletons instead of the empty welcome page, listing retried, 4 at a time, known projects not re-downloaded | web | n/a | Server restore exists only on web (desktop keeps projects in a local folder). |
| Draft PUTs (`local-edit-script`, `local-timeline`) upload only the changed file to S3 | shared backend | — | Fixes both clients at once; no gap. |

**Matched with different transports (not a gap):** รับวิดีโอจากมือถือ — the
desktop receives over LAN (Electron main-process listener); the web receives
through the backend as a courier (`routers/transfer.py`: single-use 30-min
ticket, unauthenticated phone upload where the token is the credential, web
polls + downloads + DELETEs; abandoned tickets swept with the transcode
scratch). Same feature, transport per platform.

**Closed 2026-09-09 (ported to desktop, shipping in the next build):** inline
script edit + autosave · ปรับช็อต v3 (selection-is-playback, ย้อนกลับ, commit
from any shot, identical card sizing, disabled-with-reason, thumb timeouts,
autoplay retry) · edit-script alternates refill · spinners + pulsing Skeleton ·
AI thinking hidden on the progress page · captions default OFF (both sides now
OFF). Still open: persisted lifecycle log / Settings diagnostics tab (desktop
has app.log — weaker need).

## Platform limits — hidden on purpose, NOT a to-do

| What | Hidden on | Reason |
|---|---|---|
| เอฟเฟกต์การซูม (zoom effects) | web | Needs the render-effects ffmpeg pass; the browser engine has no equivalent yet. |
| AI แก้ให้ (re-edit) | web | Needs `render-ai-preview`. |
| ดูดเข้าจังหวะ (beat snap) | web | librosa is server-side; the web build does not upload music. |
| รับจากมือถือ / ส่งไปมือถือ, phone remote | web | LAN server lives in the Electron main process. |
| เปิดโฟลเดอร์โปรเจกต์ | web | No filesystem access; the web shows OPFS usage instead. |
| Background rendering while the tab is suspended | web | No web API keeps a page working once the browser suspends it — not a Worker, not a PWA, not a service worker. |
