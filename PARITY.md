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
