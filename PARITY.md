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
| Edit-script refill when the local copy has zero `alternates` | web | desktop | Found on web (same project, two browsers, ปรับช็อต missing in one). The desktop can hold a stripped script for the same reason — an editor save writes a script with no alternates. |
| ปรับช็อต shown DISABLED with a reason when no shot has alternates (was hidden outright) | web | desktop | Web fix after the button "vanished" between projects. |
| Shot swap: selection is playback (no play button, selected option loops) | web | desktop | Web UX change. |
| `mobile-probe.js` — collapse/starvation/reachability harness | web | n/a | Browser-only concern. |
| Inline script editing + autosave on the project detail page | web | desktop | Owner asked for it on web first (2026-09-09); desktop's script panel is still read-only. |
| ปรับช็อต: selection-is-playback, ย้อนกลับ button, ทำคลิปใหม่ from any shot, equal card sizing by construction | web | desktop | Same session; desktop still has the play-button overlay and last-shot-only commit. |
| Spinners on every working surface (progress card, job bar, Progress primitive `busy`, pulsing Skeleton) | web | desktop | Owner request 2026-09-09. |
| Captions default OFF for new projects | web | desktop | Web pref default flipped 2026-09-09; desktop default is still ON. Decide one way and align. |
| Caption preview thumb falls back to the server poster frame for undecodable (HEVC) sources | web | n/a | Desktop decodes HEVC locally; no gap. |
| Transcode download resume + retry-safe DELETE | web | n/a | Server transcode exists only on web. |
| No-target cut length: prompt anchor removed (25–35s band), footage-scaled wording, NO_VO length policy | shared backend | — | Fixes both clients at once; no gap. |

## Platform limits — hidden on purpose, NOT a to-do

| What | Hidden on | Reason |
|---|---|---|
| เอฟเฟกต์การซูม (zoom effects) | web | Needs the render-effects ffmpeg pass; the browser engine has no equivalent yet. |
| AI แก้ให้ (re-edit) | web | Needs `render-ai-preview`. |
| ดูดเข้าจังหวะ (beat snap) | web | librosa is server-side; the web build does not upload music. |
| รับจากมือถือ / ส่งไปมือถือ, phone remote | web | LAN server lives in the Electron main process. |
| เปิดโฟลเดอร์โปรเจกต์ | web | No filesystem access; the web shows OPFS usage instead. |
| Background rendering while the tab is suspended | web | No web API keeps a page working once the browser suspends it — not a Worker, not a PWA, not a service worker. |
