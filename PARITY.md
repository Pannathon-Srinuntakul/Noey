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
| Left-trim keeps the handle under the pointer (lane scrolls by the growth, CapCut-style), preview seeks to the trimmed edge, half-viewport tail; playhead line drawn above trim handles; rAF-coalesced trim + scrub; memoized per-block offsets | web | desktop | 2026-09-21: "ยืดไปด้านหลังแล้วช็อตเดินหน้า", playhead hidden under the gold handles, drags lagging. Desktop `TimelineEditor.tsx` was identical code then — no longer true: since the 2026-09-21 refactor (rows below) web's editor is split into hooks and memoized components, so these fixes port by function name (`trimCut`, `queueScrollShift`, `bindTrimDrag`), not by copying the file. |
| ปรับช็อต → ทำคลิปใหม่ goes straight to the progress screen and shows busy immediately; terminal `local-status` PATCH retried in the background instead of failing a finished render; "HTTP 0" mapped to the Thai network message (`responseErrorDetail`) | web | desktop (swap UI + render path partly) | 2026-09-21: "กดทำคลิปใหม่แล้วไม่มีอะไรเกิดขึ้น … เจอ http 0". Desktop has no "HTTP 0" (its proxy rethrows) but has the same uncaught terminal PATCH. |
| Filmstrip job cancelled when the editor closes (caller `signal` honoured by the engine) | web | n/a | Web engine only — the desktop sidecar is a separate process queue. |
| Fresh-browser restore lists projects as they arrive, skeletons instead of the empty welcome page, listing retried, 4 at a time, known projects not re-downloaded | web | n/a | Server restore exists only on web (desktop keeps projects in a local folder). |
| Draft PUTs (`local-edit-script`, `local-timeline`) upload only the changed file to S3 | shared backend | — | Fixes both clients at once; no gap. |
| A start (reload, retry, recut) first asks the server for a running job (`findRunningJob` → `GET /videos/{uid}`) and follows it instead of starting a second paid run; Cmd/Ctrl+R / F5 while work is in flight asks in the app's dialog (`useReloadGuard`) | web | desktop (attach half) | 2026-09-21 live report: reload mid-analysis → "ยังทำงานอยู่ (สถานะ processing)" error while the first run finished unread. The attach logic belongs in desktop's `useProjectPipeline` too (an app restart has the same window); the reload dialog is browser-only by nature. |
| Editor clicks never leave focus on a button or scene block (`keepFocusOffControls` on the editor root, `data-focus-ring="none"` on blocks), so Space/arrows draw no gold focus ring and Space cannot press a focused button | web | desktop | 2026-09-22, owner: "ไม่ว่าจะกดอะไรฉันก็ไม่ต้องการให้มันขึ้นโฟกัสแบบนี้". Desktop's `TimelineEditor.tsx` focuses blocks the same way (dnd-kit attributes). |
| Project card ⋮ menu that opens upward is anchored by its bottom edge (`ProjectGridCard` `openMenu`), so it sits on the button instead of floating a fixed-height estimate above it | web | desktop | 2026-09-21 live report (gap between ⋮ and the menu). The estimate counts the desktop-only folder row, so the gap was web-only in practice, but desktop's copy positions the same way. Not in this machine's partial desktop tree. |
| Editor Limits design — near-limit / payment-failed banner (`components/shell/UsageBanner.tsx`, `lib/usageInfo.ts` + `lib/usageContext.tsx` `UsageProvider` in App), wizard pre-upload notices for footage / storage / project count with the blocked start (`WizardPage.wizardPlanNotices`, `components/LimitNotices.tsx`), locked music row (`WizardStepOutcome musicLocked`) and locked music lane (`timeline/lanes/MusicLane.tsx`) | web | desktop | 2026-09-22, docs/design/editor-limits.md §2/§4 + plan features (docs/token-billing-plan.md §8). The backend enforces every rule for both clients (403/422 with a Thai `message`), so the desktop is protected — only the before-upload UI is missing. Not in this machine's partial desktop tree (no AppShell, WizardPage, WizardStepOutcome, MusicLane); `lib/planLadder.ts` is already copied byte-identical for the port. |
| สไตล์ studio (nav item + `library` route) and the wizard's สไตล์การตัด picker hidden behind `canUseStyles` in `lib/platformFeatures.ts` | desktop (still shows them) | web | 2026-09-22, owner: styles are not being opened to users soon, so the web launch ships without them. A product decision, not a platform limit — the web can run them. Desktop keeps them until the owner decides otherwise; turning web back on is the flag alone. |
| Wizard: script-style picker (รีวิวสินค้า / ตลก / ให้ข้อมูล / เล่าเรื่อง) removed, `buildDubBrief` no longer adds a "สไตล์:" line; mode copy says ตัดฉากเด่น is for selling clips (ปักตะกร้า) and ตัดช่วงเงียบ no longer claims to cut repeated takes | web | desktop | 2026-09-21, owner: the picker only added a brief line no prompt rule read, and ตัดช่วงเงียบ never detected a sentence said twice. Desktop's `lib/dubBrief.ts` + wizard need the same edit; this machine's desktop tree has no wizard components. |
| Filmstrip lanes repaint only when the picture changes: `FilmstripCanvas` keeps one effect for the viewport subscription + tile waits, and a prop change repaints through it instead of tearing it down; a scroll that stays in the same slot range draws nothing; the canvas is resized only when its size changes and zeroed once offscreen; tile URLs built once per strip (`useFilmstripStrips` `toStrip`) | web | desktop | 2026-09-21 TimelineEditor refactor, step 1: the old single effect tore down, re-subscribed and redrew every lane on every prop change, and redrew (reallocating the canvas) on every scroll frame. Desktop's `FilmstripCanvas.tsx` / `useFilmstripStrips.ts` are not in this machine's partial desktop tree — port by function name. |
| Timeline editor state in hooks (`useEditorHistory`, `useDraftAutosave`, `useTimelineViewport`, `usePreviewPlayer`, `useWindowKeydown`) with one writer for the cut list (`writeCuts` / `editCuts`), and the fixes that came with it: a cut edit records one undo step, pushed by its handler, not two from inside a `setCuts` updater (StrictMode/dev); cut ids stay unique after reopening on a kept history (`highestNewCutNumber`); shortcuts read the newest state (Ctrl+S after a caption edit rendered the old lines); music moved or trimmed during playback is no longer re-seeked to its old spot by the frame loop; duplicate/delete of a missing cut add no empty undo step; the keydown listener is bound once and the unsaved guard no longer re-runs every render | web | desktop | 2026-09-21 TimelineEditor refactor, step 2. The id fix is web-only by nature — kept history exists only on web. Desktop's `TimelineEditor.tsx` has the same updater-push, stale-shortcut and music-loop code; port by function name (`writeCuts`, `editCuts`, `withNewScene` / `withNewAngle` / `withDuplicate`, `useStableCallback`). |
| Timeline editor renders only what changed: the header, preview, inspector parts, toolbar, ruler, lanes, scene blocks, beat ticks and playhead are memo()'d components in `components/timeline/`, fed props that keep their identity (`useStableCallback` wrappers, memoized arrays and maps; stable dnd-kit sensors and item list); the playhead time is no longer React state (`paintTime`'s `onPaint` updates only the VO lane's speaking line); playback and scrubbing no longer rebuild the segment list per frame (`findSegmentAt`, memoized `editedInById` / `editedDur`); caption-edge, music and source-move drags write at most once per frame; the editor is exported memoized and `TimelineRoute`'s close is stable, so draft saves no longer re-render it. Behaviour changes: dialogs keep focus while the preview plays (focus used to jump back to the panel on every render); the VO speaking highlight switches exactly at the line boundary (was up to ~250 ms late); the transport's ←/→ keys step from the live position | web | desktop | 2026-09-21 TimelineEditor refactor, step 3: a trim, scrub, keystroke or music drag re-rendered the whole editor and every block, and every `timeupdate` re-rendered it again. Desktop's `TimelineEditor.tsx` still does, keeps `currentTime` in state and hands Dialogs a new `onClose` per render. Port by component and function name (`PreviewPane`, `ImageLane`, `EditedCutBlock`, `onPaint`, `findSegmentAt`, `sourceNeighborBoundsById`). |
| Captions follow the cut: only caption lines the user EDITED are stored (`edited` + a source-footage `anchor`, `deleted` tombstones) and every render, the SRT, the CapCut bundle, the detail page transcript and the editor lane derive the rest from the cut as it is (`lib/captionEdits.ts` `resolveCaptionLines` / `timelineCaptionLines`); edits re-time through their anchor on trim/delete/reorder/shot swap and carry from the silent cut onto the voiced timeline; recut and any new AI cut clear them (revert restores); the silent render no longer persists its burned lines; voiced timeline cuts keep `voiceoverLineId`/`voiceoverScript`; caption chip spans every scene a line covers; edge snap never goes under the 0.2 s minimum (`snapCaptionEdge`); an untouched timecode field commits nothing (`timecodeCommitValue`); output-clock captions hidden in source view | web | desktop | 2026-09-21 bug hunt: captions were frozen to the cut at editor-open and stored on every save, so trims, deletes, reorders, retyped lines and recuts burned the old cut's captions. **Data compatibility:** a desktop build reading a web-saved project treats `captionLines` (now edits only) as the whole list and would burn only the edited lines — port `captionEdits.ts` + the pipeline/renderer/editor changes before desktop opens web-edited projects. Not in this machine's partial desktop tree. |
| Server copy, recut, shot swap and music stay consistent: every edit-script / timeline PUT (drafts, Save, shot swap, revert, inline line edit) goes through one ordered queue with superseded drafts skipped (`lib/serverWriteQueue.ts`) and plan-dub waits for it; ย้อนกลับ puts the kept script + timeline back on the server and restores the resting step (`previousRender.step` / `renderedSig`); a starting run drops the stored job id (`withoutJobId`) and a recut owes its analysis (`analysisOwed`) so neither a reload nor ลองใหม่ re-renders the old cut as the recut; locked swaps match planned cuts by footage + overlap and a swap no cut matches is refused, not dropped (`retimeTimelineForSwap` `missed`); ปรับช็อต offers the AI's original back and keeps the first `swappedFrom` (`swapCandidates`); ทำซ้ำ drops AI shot meta; replaced music tracks kept until the editor closes (`importMusic` unique names, `pruneMusic`); music edits flag a voiced final as unrendered (`renderSig` covers its music); the music lane is hidden where no music is mixed; scene clips are staged and swapped in after the render (`.clips_next`); `project.json` is always re-uploaded | web | desktop | 2026-09-21 bug hunt (data-sync group): a draft could land after Save and plan-dub planned the old cut; undoing a swap/recut left the server on the discarded script; locked swaps silently skipped; reload/retry during a recut re-rendered the previous result; undoing เปลี่ยนเพลง pointed at a deleted file; a stopped render left a partial `clips/`. Desktop's `useProjectPipeline`, `shotSwap.ts`, `ShotSwapReview`, `timelineMath.ts` and `main/projects.ts` `importMusic` have the same code; port by function name. The `projectSync` and `.clips_next` halves are web-only by nature (desktop has no sync, and its sidecar writes atomically). Not in this machine's partial desktop tree. |
| Editor preview behaves like a normal editor: opens paused on the first scene (`resumePlaybackRef` starts false); the selection follows clicks only — never the playhead, playback or a scrub — and a click only selects (`selectCut`), no seek, no scroll; a trim still shows the edge it trims (`showCutFrame`); follow-scroll pages with the playhead only while playing, off on any manual scroll or zoom, back on at the next play (`followOnRef`); a switch to another source file holds the last frame on a canvas until the new file has seeked (`holdFrame`); scenes play to their full out-point and the clock is clamped to the scene (`sceneIsOver`, `editedTimeIn`) — and the bug-hunt fixes with it: the preview re-resolves its scene after a delete/undo/reorder/AI re-edit (`resolveEditedPosition`), a paused seek or trim near an out-point no longer advances and plays, a timeupdate during a file load cannot skip a scene, a jump into another file keeps playing, a source-lane click is clamped to the clicked file, a view switch lands on the exact frame it left | web | desktop | 2026-09-21 owner editor-feel list (F1–F3, F8–F10) + bug hunt preview group. Desktop's `TimelineEditor.tsx` has the same player code inline (selection synced to the playhead, `EPS = 0.05` advance, 4 s follow resume, `resumePlaybackRef` true at open); port by function name from web `components/timeline/hooks/usePreviewPlayer.ts`, `useTimelineViewport.ts` and `components/timeline/previewMath.ts`. Not in this machine's partial desktop tree. |
| Editor edit operations + input: every block's edges trim it (invisible 8px zones with the resize cursor, gold handles on the selected block, `TrimBar` `visible`), a block is selected on press, and a source-view trim shows its edge too (`trimCut`); Space only plays/pauses (dnd-kit `KeyboardSensor` starts on Enter only) and a handled key (`defaultPrevented`) never also nudges or closes; Esc in a text/timecode field only leaves the field, and a timecode field's Esc really reverts (`TimecodeInput` `cancelRef`); the script box keeps spaces and new lines (`lineScriptDraft`), trimmed in `cutPayload`; N / M select the new scene, and N in the edited view goes after the scene under the playhead (`withNewScene` `afterCutId`); voiceover lines stay in one piece on reorder / duplicate / N (`withReorder`, `insertIndexOutsideLineRuns`); `[` / `]` in the source view act only on the file on screen and stop at lane neighbours; a first-edit keystroke marks the draft dirty (`useDraftAutosave` `openedOnRef`); an undo, redo or push first lands a still-open or still-committing text edit (`createEditHistory` `settleEdit`), and so does the way out | web | desktop | 2026-09-22 owner editor-feel list (F4–F7, F11) + bug hunt editor-ops group (#10, #12, #13, #31, #32). Desktop's `TimelineEditor.tsx`, `timelineMath.ts` and trim handles have the same code; port by function name. Not in this machine's partial desktop tree. |
| Review repairs to the caption, data-sync and editor rows above: a caption list stored by an older build (no edit marks) is converted, not dropped — lines whose text the derivation no longer says become anchored edits (`storedCaptionEdits`), everywhere the stored list is read (render, SRT/CapCut, detail page, editor open); `renderSig` reads an empty caption list as none, and an older build's `renderedSig` is upgraded in the first draft or music patch that finds the project still in its rendered state (`needsRenderFields`); every block gets trim zones (a third of a narrow block, `edgeZonePx`) and an unselected block's zones sit under the playhead's grab strip; a text box that keeps focus through undo / redo / delete keeps recording (`createEditHistory` re-opens the edit); a click on another file's scene in the source view loads that file on the scene's first frame (`selectCut`); replaced music is pruned only after the editor has unmounted and its in-flight music write has landed, keeping every track the kept undo history names (`keptMusicPaths`, `whenEditorClosed`) | web | desktop | 2026-09-22 review of the bug-hunt fixes: old projects lost their hand-fixed captions, legacy voiced+music projects always read unrendered, a press on the playhead at a cut trimmed the neighbour, and undo after reopening the editor still reached a pruned track. Port with the rows above, by function name. Not in this machine's partial desktop tree. |
| Beat snap uses the song as trimmed and placed: plan-dub takes `musicOffsetSec` / `musicTrimInSec` / `musicTrimOutSec` (JSON) and analyze-frames / analyze-video / reedit-dub-scenes take `music_offset_sec` / `music_trim_in_sec` / `music_trim_out_sec` (form) | shared backend | desktop client | 2026-09-22 bug hunt #41: beats were matched on raw file time, so trimming or sliding the song gave off-beat cuts. The backend half is done; the desktop must send `project.music`'s `offsetSec` / `trimInSec` / `trimOutSec` on those four calls (defaults = untrimmed at 0, so nothing breaks meanwhile). #41 stays open until it does. Web uploads no beats (beat snap is a platform limit there), so it has nothing to send. |
| Token billing — wizard pre-flight estimate ("ใช้ประมาณ 18% ของโควตารายสัปดาห์" as soon as every clip has a length), block BEFORE upload with the "โควตารอบนี้หมดแล้ว" dialog (`components/QuotaDialog.tsx`), "ใช้ยอดเงินคงเหลือ" consent carried to the start call on `LocalProject.allowWallet` (`lib/usageEstimate.ts`, `lib/useUsageEstimate.ts`, `components/wizard/UsageEstimate.tsx`, `WizardPage` / `WizardStepFiles`) | web | desktop | 2026-09-22 client phase of docs/token-billing-design.md. This machine's desktop tree has no wizard (`WizardPage.tsx`, `components/wizard/*`, `wizardState.ts`, `components/ui/*`). The desktop pipeline already honours `allowWallet` and the server refuses over-limit starts, so the desktop gap is the preview + pre-upload block, not enforcement. Port the four files by name. |
| Token billing — recut dialog estimate + wallet consent; "ตัดใหม่" disabled when the plan cannot pay (`RecutDialog`, `ProjectGridCard` recut handler) | web | desktop | Same session. Desktop's `RecutDialog.tsx` / `ProjectGridCard.tsx` are not in this partial tree. |
| Token billing — job progress "รอคิว" state for `step: "waiting_slot"` with the plan's concurrency (`JobProgressPage`, `jobs.tsx` publishing `waitingSlot`) and the limit error card's "ใช้ยอดเงินคงเหลือทำต่อ" (`ProjectGridCard`, `ProjectDetailPage` → `pipeline.continueOnWallet`) | web | desktop (UI half) | Same session. The desktop `useProjectPipeline` HAS `waitingSlot`, `continueOnWallet`, `billingStop` and the typed `pollJob` stop/queue handling; only the screens are missing here (`JobProgressPage.tsx`, `jobs.tsx`, `ProjectGridCard.tsx`, `ProjectDetailPage.tsx`). |
| Token billing — styles + effects clients (`stylesApi.ts`, `effectsLocalApi.ts`) throw typed refusals via `errorFromResponse` | web | desktop | Same session. Desktop `api.ts` / `videosLocalApi.ts` already build refusals through `errorFromResponse`, and `apiError.ts` landed on desktop 2026-09-23; `stylesApi.ts` / `effectsLocalApi.ts` are missing from this tree. Neither side sends `allow_wallet` on `plan-effects` / `POST /effect-styles` yet — those features are hidden on web, so the desktop port should add it there. |
| Token billing — `noLeaks.test.ts` "the UI never states usage in tokens" guard | web | desktop | Same session; desktop has no `noLeaks.test.ts` in this tree. |
| Editor interaction standard (snap engine on every drag incl. VO lines/playhead/markers, Alt suppress + Shift+N toggle, guide line, roll/slip gestures, keyboard nudge/reorder/trim-to-playhead Q/W, multi-select + marquee + batch delete, copy/paste, named undo + toasts with undo on delete/reorder, context menu, markers, I/O range, skip scene, play scene/around/loop, skim, anchored + pinch zoom, fit toggle, drag auto-scroll, touch scrub + scene strip, ARIA listbox/slider/live region, reduced motion) | web | desktop | Built on web 2026-09-27 per the editor-standard plan; the desktop tree on this machine is partial (no `lib/timelineMath.ts`, `TimelineEditor.tsx` is the 4226-line pre-refactor monolith) so nothing ports here; port by function name (`snapTargets`, `selection`, `useEditorShortcuts`, the lane props) once the desktop editor is split like web's. Beat snapping stays desktop-only as a SOURCE of snap targets (`canSnapToBeat`: the web runs no beat analysis) — a platform limit, not a gap; the magnet itself (cut edges, playhead, VO lines, captions, markers, range) is on both once ported. |

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


| ตัดไฮไลต์จากคลิปยาว: the "ความยาวไฮไลต์" chooser removed — length is always the AI's (`WizardStepOutcome` longform branch, `outcomeStepGate`, `buildSubmission`, `summaryRows`) | web | desktop | 2026-09-23, owner decision: a length picked before the clip is read forces the selector to pad or truncate a highlight. Desktop's wizard files are not in this partial tree; port with the rest of it. |
| Quota pause + resume: a run that exhausts the plan pauses in `paused_quota` and continues from the boundary it stopped at (`GET/POST /videos/{uid}/resume`, `PausedPanel`, `useProjectPipeline` resume path) | web | desktop | 2026-09-26. Backend is shared, so desktop gets the pause for free — but nothing there reads `/resume` or offers to continue, so a desktop user sees a stopped project with no way back. Desktop's pipeline files are not in this checkout. |
| ปรับช็อต walks every shot including ones with no alternative, and the shot strip no longer crops the frames (`ShotSwapReview`) | web | desktop | 2026-09-26, owner-reported. Desktop's `ShotSwapModal.tsx` is not in this checkout. |
| Timeline interaction pass: playhead revealed after every jump, Up/Down between cut boundaries, edits reveal + flash + toast, scene chips carry their own state, J/K/L and Enter-opens-shot-swap (`components/timeline/**`) | web | desktop | 2026-09-26. The whole `components/timeline/` tree is missing from this checkout. |

## 2026-09-23 — a gap that was not a gap

Several rows above said a desktop twin was "missing from this partial tree".
Some of them were not missing: `.gitignore` carried a bare `desktop/` while 40
desktop files were already tracked, so every NEW desktop file was left out of
every commit silently. `planLadder.ts`, `usageLimits.ts` and the whole
`components/settings/` folder were on disk and had never reached a commit. The
rule is now narrowed to build output, and those files are committed.

`apiError.ts` was a real gap of the worst kind: desktop's `api.ts` imported it
and the file did not exist, so the renderer could not build at all. Copied
across with its tests.

Still genuinely absent from this checkout (never committed anywhere, so they
live on another machine): `main/tasteLog.ts`, `main/lanReceive.ts`,
`main/prefs.ts`, `main/remoteAccess.ts`, `main/remotePage.ts`,
`main/remoteApi.ts`, and the renderer screens the rows above name. `npm run
typecheck` in `desktop/app` fails on the first three until that tree is whole.

## 2026-09-27 — editor interaction standard, web only (itemised)

The row under "Open gaps" summarises this; here is the full list, so the
desktop port can be checked off one item at a time. Everything below landed
on web on 2026-09-27 and none of it exists on desktop (the desktop
`components/timeline/` tree is not in this checkout; its `TimelineEditor.tsx`
is still the pre-refactor monolith, so port by the function and prop names
given here once it is split like web's). Nothing in this list is a platform
limit except where marked.

**Snapping** (`lib/timelineSnap.ts`, `components/timeline/snapTargets.ts`,
`GuideLines.tsx`)
- One magnet toggle `ดูดขอบ` in the toolbar, never hidden or disabled,
  remembered in `localStorage` (`noey.timeline.snapEnabled`), Shift+N toggles
  it with a toast.
- Targets on the output clock: every other scene's edges (edge-to-edge, own
  edges excluded), the playhead, voiceover line starts and ends, caption chip
  edges, the music block's edges, beats, markers, the I/O range, t=0 and the
  sequence end. Source view: the lane's other cuts, the playhead when that
  file is on screen, and the file end.
- Alt held suppresses snapping for the rest of the drag (window-level
  modifier tracker + the drag binder's per-frame `altKey`); a snap draws a
  guide line with a triangle head; the scrub has a softer 6 px threshold and
  Alt/Shift bypass; every drag result is frame-quantised before snapping.
- Beat targets are the one platform limit: the web runs no beat analysis, so
  `canSnapToBeat` gates only that SOURCE — the magnet itself must exist on
  both.

**Drag gestures** (`lib/pointerDrag.ts`, `lanes/EditedCutBlock.tsx`,
`lanes/SourceLanes.tsx`, `lanes/TrimBar.tsx`, `lanes/MusicBlock.tsx`)
- One window-level pointer-drag binder for every drag: one frame per rAF,
  Escape cancels (values restored BEFORE the history bracket closes, so no
  step is recorded), pointercancel ends, edge auto-scroll (quadratic, 40 px
  band, 24 px max) with the scroll delta folded into the drag delta.
- Roll: ⌘/Ctrl+drag a trim handle moves the boundary between two scenes,
  total length unchanged (`rollCutBoundary`); two-up preview shows the
  outgoing and incoming frames side by side (`beginTwoUp`/`paintTwoUp`/
  `endTwoUp`, `PreviewPane twoUp` + `twoUpIncoming`).
- Slip: Alt+drag a scene body moves its window inside the source, block stays
  put (`slipCut`); source-view move is a snapped slip.
- Trim handles: hover-revealed bars, coarse-aware grab zones (22 px), red
  `หมดฟุตเทจ` when the footage end is hit, live readout pills (`DragReadout`:
  `+0.40 วิ`, `เลื่อนรอยตัด ±`, `เลื่อนหน้าต่าง`, `เริ่มที่ 0:03.2`), a
  tooltip with the AI's shot note, sticky play-order label.
- Reorder: `DragOverlay` ghost with `ก่อนฉาก N`/`ท้ายสุด` caption, origin slot
  dimmed, multi-drag moves a contiguous selection (`withReorderMany`), touch
  reorder by long-press (300 ms).

**Selection** (`components/timeline/selection.ts`, `lanes/marquee.ts`)
- Multi-select: ⌘/Ctrl+click toggles, Shift+click ranges from the anchor,
  Shift+drag on the lane background is a marquee (intersect, additive), ⌘A /
  ⌘⇧A select all / none, Esc clears, context menu `เลือกตั้งแต่นี้ถึงท้าย`.
- Batch delete in one undo step, `ลบ N ฉาก` labels in the inspector and
  toolbar, `เลือก N ฉาก` chip, dashed ring for secondary selection, 2 px ring
  for the primary; `พอดีฉาก` zooms to the selection.

**Keyboard** (`components/timeline/shortcuts.ts`,
`hooks/useEditorShortcuts.ts`, `dialogs/ShortcutsSheet.tsx`)
- Full registry with a conflict-guard test; sheet in four groups
  (เล่น / มุมมอง / เลือก / แก้ไข) with gesture rows and the Alt/Shift footer.
- Added chords: Q/W trim to playhead, Alt+←/→ nudge one frame (+Shift = 10),
  ,/. slip one frame (+Shift = 10), E extend edit, Alt+↑/↓ move scene, D
  skip/unskip, ⌘D duplicate, ⌘C/⌘X/⌘V copy/cut/paste (fresh ids, meta
  stripped; dub copies become angles of the line before), I/O set range,
  Shift+I/Shift+O jump to range ends, Alt+X clear range, Shift+Delete removes
  the range from the sequence (`withRangeRemoved`), Shift+M add marker,
  Shift+↑/↓ jump between markers, ⌘1/⌘2 view switch, Shift+Z fit toggle, F
  zoom to selection, Shift+K play around the nearest cut, Shift+L loop,
  Shift+Space play the selected scene / I–O range, Shift+N snap toggle,
  Home/End.
- Key bursts within 400 ms are ONE undo step (`keyBurstIsNewStep`).

**History and answers** (`lib/editorHistory.ts`, `hooks/useEditorHistory.ts`,
`LiveRegion.tsx`)
- Named undo steps: every step carries a label; undo/redo buttons say
  `เลิกทำ: ลบฉาก`; toasts name the step and offer `เลิกทำ` on delete, move,
  range delete and the AI re-edit; a trim toasts only when something changed.
- Every answer also reaches assistive tech through an `aria-live` region.
- `changedCutIds` flashes every scene an edit touched (both halves of a
  split, every retimed scene of a batch), respecting `prefers-reduced-motion`.

**Playback** (`hooks/usePreviewPlayer.ts`, `playRange.ts`, `PreviewPane.tsx`,
`ui/VideoTransport.tsx`)
- Play range (I/O), play scene, play around a cut (±1 s), loop (range or whole
  sequence) with a transport button; skipped scenes are jumped over.
- Hover skim (`แกนพรีวิว`): the frame under the pointer shows in the preview
  while the playhead stays put; remembered in `localStorage`
  (`noey.timeline.skim`); off on touch.
- Timecode entry: clicking the transport clock opens an inline `m:ss:ff`
  field (`parseFramesForm`).

**Viewport** (`hooks/useTimelineViewport.ts`, `viewportMath.ts`,
`TimelineRuler.tsx`, `Playhead.tsx`, `MarkerLayer.tsx`)
- Anchored zoom: ⌘/Ctrl(+Alt)+wheel keeps the time under the pointer; Shift
  or horizontal wheel scrolls; two-finger pinch on touch; `พอดีจอ` is a fit
  toggle that remembers the previous zoom; zoom to range.
- Ruler on `rulerTicks` (major + minor ticks that never collide), I/O range
  band, marker flags (click seek / drag with snap / double-click rename /
  right-click remove; per-project in `localStorage`, not in undo).
- Playhead is a `role=slider` with `aria-valuenow`, coarse-width grab, and
  sticky off-screen edge-hint pills.
- Skip scene: `D` / context menu / inspector; skipped scenes render as a
  zero-width stub, are dropped from the render save (`cutPayload dropSkipped`)
  and kept in the draft.
- Context menu on a scene (right-click or `⋯` on the strip) with the
  inspector's action set, keyboard-walkable, focus restored on close.

**Touch** (`lanes/SceneStrip.tsx`, viewport `touchScrub`/`leadPx`)
- Phone model: a swipe on the timeline IS a scrub (playhead pinned at the
  centre, axis padded by `leadPx`), layout toggle `ไทม์ไลน์ / ฉาก` with the
  scene strip (64×40 tiles, tap select, double-tap open, long-press reorder,
  `⋯` menu) as the default on touch; ruler 28 px tall on coarse pointers;
  scroll container is `touch-action: pan-x pan-y` so a pinch reaches the
  zoom listeners.

**ARIA**
- Lanes are `role=listbox` (`aria-multiselectable`), blocks `role=option`
  with `aria-selected`, trim handles and caption edges `role=slider` with
  value text, voiceover lines `aria-current` while speaking, roving
  `tabIndex`, a real `:focus-visible` ring offset 3 px so it does not read as
  a second selection border.
