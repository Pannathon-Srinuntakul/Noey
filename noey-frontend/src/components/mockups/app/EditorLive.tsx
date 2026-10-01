"use client";

import { useEffect, useRef } from "react";
import { FOOTAGE_VIDEO, SAMPLE_CUT_SECONDS, SAMPLE_LINES, SAMPLE_SCENES, SAMPLE_VOICEOVER, sceneStill, tileAt, tilePosition } from "../sample";
import { fmtTime, fmtTimeTenths, lineLabel, lineScenes, sceneAt, sceneMeta } from "./editorMath";

/**
 * Brings an editor mock-up to life the way the real editor follows its
 * <video> (usePreviewPlayer / useTimelineViewport.paintTime):
 *
 * - the sample cut plays in the preview; the playhead, the caption overlay
 *   and the voiceover line being spoken follow it;
 * - a visitor can scrub — drag or click the ruler and lanes, or use the arrow
 *   keys on the playhead slider: the footage seeks, the caption and the scene
 *   under the playhead follow, the inspector shows that scene; letting go
 *   resumes playback;
 * - clicking (or tabbing to) a scene selects it — gold border and trim bars —
 *   and puts the playhead at its start.
 *
 * Footage plays only while the mock-up is on screen, its hero beat (if any) is
 * showing and the page is visible; never with reduced motion, Save-Data or a
 * low-power device, where scrubbing swaps the scene stills instead. At most
 * one mock-up plays at a time on a phone and two on a desktop. Nothing loads
 * until it is about to play (preload="none", sources added on demand).
 * Without this script the interactive layer stays inert, so nothing looks
 * usable that is not.
 */

interface Player {
  ratio: number;
  wants: boolean;
  playing: boolean;
  start: () => void;
  stop: () => void;
}

const players = new Set<Player>();

function limit() {
  return window.matchMedia("(max-width: 767px), (pointer: coarse)").matches ? 1 : 2;
}

/** Play the most visible players that want to, up to the limit; pause the rest. */
function schedule() {
  const hidden = document.visibilityState === "hidden";
  const ranked = [...players].filter((p) => p.wants && !hidden).sort((a, b) => b.ratio - a.ratio);
  const allowed = new Set(ranked.slice(0, limit()));
  for (const p of players) {
    if (allowed.has(p)) {
      if (!p.playing) p.start();
    } else if (p.playing) p.stop();
  }
}

function stillOnly() {
  const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
  return (
    window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    !!nav.connection?.saveData ||
    (nav.deviceMemory !== undefined && nav.deviceMemory <= 2) ||
    (nav.hardwareConcurrency !== undefined && nav.hardwareConcurrency <= 2)
  );
}

const DURATION = SAMPLE_CUT_SECONDS;
/** The last frame's time: the playhead never parks past the cut. */
const LAST = DURATION - 1 / 24;
/** How long the timeline waits after a key before playing on. */
const KEY_RESUME_MS = 1200;
/** How long a phone's hero stays on the editor after the visitor's last touch. */
const HOLD_MS = 8000;

export function EditorLive({
  beat,
  video: withVideo = true,
  demoPick,
}: {
  /** The hero beat this editor belongs to; omitted outside the hero. */
  beat?: number;
  /** Play the footage (otherwise the scene stills stand in). */
  video?: boolean;
  /** The scene the hero's pointer clicks a moment after the editor appears. */
  demoPick?: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    const root = video?.closest<HTMLElement>(".am");
    if (!video || !root) return;
    const scene = root.closest<HTMLElement>("[data-scene]");
    const playable = withVideo && !stillOnly();
    const one = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector);
    const all = <T extends HTMLElement = HTMLElement>(selector: string) => [...root.querySelectorAll<T>(selector)];

    const px = Number(one("[data-am-px]")?.dataset.amPx ?? 0);
    const heads = all("[data-am-playhead]");
    const caption = one("[data-am-caption]");
    const lines = all("[data-am-vo]");
    const blocks = all("[data-am-scene]");
    const caps = all("[data-am-cap]");
    const picks = all<HTMLButtonElement>("[data-am-pick]");
    const scrub = one("[data-am-scrub]");
    const layers = all(".am-hits");
    const still = one<HTMLImageElement>(".am-still");
    const stillSource = still?.parentElement?.querySelector<HTMLSourceElement>("source") ?? null;
    const inspector = {
      no: one("[data-am-i='no']"),
      meta: one("[data-am-i='meta']"),
      label: one("[data-am-i='line-label']"),
      line: one("[data-am-i='line']"),
      angles: one("[data-am-i='angles']"),
    };
    const angleSlots = all("[data-am-angle]");
    const initial = Number(blocks.find((block) => block.hasAttribute("data-sel"))?.dataset.amScene ?? 0);

    let selected = initial;
    let shown = -1;
    let valueText = "";
    let frame = 0;
    let dragging = false;
    let resumeTimer = 0;
    let holdTimer = 0;
    let demoTimer = 0;

    // ─── Painting ──────────────────────────────────────────────────────
    const paint = (t: number) => {
      for (const head of heads) head.style.transform = `translateX(${92 + t * px}px)`;
      const at = sceneAt(t);
      if (at !== shown) {
        shown = at;
        if (caption) caption.textContent = SAMPLE_SCENES[at].caption;
        // Instead of the footage, until it has shown: the scene's still.
        if (still && !root.hasAttribute("data-shown")) {
          const src = sceneStill(at);
          if (stillSource) stillSource.srcset = src.avif;
          still.src = src.webp;
        }
      }
      const speaking = !dragging && !video.paused ? SAMPLE_VOICEOVER.find((l) => t >= l.start && t < l.start + l.seconds)?.line : undefined;
      for (const line of lines) line.toggleAttribute("data-speaking", Number(line.dataset.amVo) === speaking);
      const text = `${fmtTimeTenths(t)} จาก ${fmtTime(DURATION)}`;
      if (scrub && text !== valueText) {
        valueText = text;
        scrub.setAttribute("aria-valuenow", t.toFixed(1));
        scrub.setAttribute("aria-valuetext", text);
      }
    };

    const select = (index: number) => {
      if (index === selected) return;
      selected = index;
      const picked = SAMPLE_SCENES[index];
      for (const block of blocks) block.toggleAttribute("data-sel", Number(block.dataset.amScene) === index);
      for (const cap of caps) cap.toggleAttribute("data-sel", Number(cap.dataset.amCap) === index);
      for (const line of lines) line.toggleAttribute("data-sel", Number(line.dataset.amVo) === picked.line);
      for (const pick of picks) pick.setAttribute("aria-pressed", String(Number(pick.dataset.amPick) === index));
      if (inspector.no) inspector.no.textContent = String(index + 1);
      if (inspector.meta) inspector.meta.textContent = sceneMeta(index);
      if (inspector.label) inspector.label.textContent = lineLabel(index);
      if (inspector.line) inspector.line.textContent = SAMPLE_LINES[picked.line - 1];
      const angles = lineScenes(picked.line);
      if (inspector.angles) inspector.angles.textContent = `${angles.length} มุม`;
      angleSlots.forEach((slot, k) => {
        const angle = angles[k];
        slot.hidden = !angle;
        slot.toggleAttribute("data-sel", angle?.index === index);
        const tile = slot.querySelector<HTMLElement>(".am-tile");
        if (angle && tile) tile.style.backgroundPosition = tilePosition(tileAt(angle.scene, 0.08));
      });
    };

    // ─── Seeking (one seek in flight; the latest target waits) ───────────
    // Starts where the server drew the playhead.
    let time = Number(scrub?.getAttribute("aria-valuenow") ?? 0);
    let seeking = false;
    let pending: number | null = null;
    const seekVideo = (t: number) => {
      if (!playable || !video.querySelector("source")) return;
      if (seeking) {
        pending = t;
        return;
      }
      seeking = true;
      video.currentTime = t;
    };
    const onSeeked = () => {
      seeking = false;
      if (pending === null) return;
      const next = pending;
      pending = null;
      seekVideo(next);
    };
    video.addEventListener("seeked", onSeeked);

    const seek = (t: number) => {
      time = Math.min(LAST, Math.max(0, t));
      paint(time);
      seekVideo(time);
    };

    // ─── Playback ──────────────────────────────────────────────────────
    const loop = () => {
      time = video.currentTime;
      paint(time);
      frame = requestAnimationFrame(loop);
    };
    const play = () => {
      if (!playable || !player.playing || dragging) return;
      void video.play().then(
        () => {
          root.setAttribute("data-playing", "");
          root.setAttribute("data-shown", "");
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(loop);
        },
        () => undefined,
      );
    };
    const pause = () => {
      video.pause();
      cancelAnimationFrame(frame);
      root.removeAttribute("data-playing");
      paint(time);
    };

    const player: Player = {
      ratio: 0,
      wants: false,
      playing: false,
      start() {
        player.playing = true;
        if (!playable) return;
        if (!video.querySelector("source")) {
          for (const [type, src] of [
            ["video/webm", FOOTAGE_VIDEO.webm],
            ["video/mp4", FOOTAGE_VIDEO.mp4],
          ]) {
            const source = document.createElement("source");
            source.type = type;
            source.src = src;
            video.append(source);
          }
          video.preload = "auto";
          video.load();
          video.currentTime = time;
        }
        play();
      },
      stop() {
        player.playing = false;
        pause();
      },
    };
    players.add(player);

    // ─── The visitor ───────────────────────────────────────────────────
    // A phone's hero moves on to the next beat on a timer; while someone is
    // using the editor, it stays (MotionRuntime reads data-scene-hold).
    const hold = () => {
      if (!scene) return;
      scene.setAttribute("data-scene-hold", "");
      window.clearTimeout(holdTimer);
      holdTimer = window.setTimeout(() => scene.removeAttribute("data-scene-hold"), HOLD_MS);
    };
    const timeAt = (clientX: number) => {
      if (!scrub) return time;
      const box = scrub.getBoundingClientRect();
      return ((clientX - box.left) / box.width) * DURATION;
    };

    let gesture: { id: number; x: number; y: number; pick: number | null; touch: boolean } | null = null;
    let swallowClick = false;
    const beginDrag = (event: PointerEvent) => {
      dragging = true;
      root.setAttribute("data-scrubbing", "");
      window.clearTimeout(resumeTimer);
      pause();
      (event.target as Element).setPointerCapture?.(event.pointerId);
    };
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      root.removeAttribute("data-scrubbing");
      play();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) return;
      const target = event.target.closest<HTMLElement>("[data-am-scrub], [data-am-pick]");
      if (!target) return;
      swallowClick = false;
      hold();
      window.clearTimeout(demoTimer);
      const pick = target.dataset.amPick !== undefined ? Number(target.dataset.amPick) : null;
      gesture = { id: event.pointerId, x: event.clientX, y: event.clientY, pick, touch: event.pointerType === "touch" };
      // A mouse on the ruler or lanes scrubs at once; on a scene, or by touch,
      // it waits to see a drag (a tap selects, a vertical swipe scrolls).
      if (pick === null && !gesture.touch) {
        beginDrag(event);
        const t = timeAt(event.clientX);
        seek(t);
        select(sceneAt(time));
      }
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.id) return;
      if (!dragging) {
        const dx = Math.abs(event.clientX - gesture.x);
        const dy = Math.abs(event.clientY - gesture.y);
        if (dx < 5 || dx < dy) return;
        beginDrag(event);
      }
      seek(timeAt(event.clientX));
      select(sceneAt(time));
    };
    const onPointerUp = (event: PointerEvent) => {
      if (!gesture || event.pointerId !== gesture.id) return;
      const tap = !dragging && gesture.touch && gesture.pick === null;
      swallowClick = dragging;
      gesture = null;
      if (tap) {
        seek(timeAt(event.clientX));
        select(sceneAt(time));
      }
      endDrag();
    };
    const onPointerCancel = () => {
      gesture = null;
      endDrag();
    };
    const pickScene = (index: number) => {
      select(index);
      seek(SAMPLE_SCENES[index].start);
    };
    const onClick = (event: MouseEvent) => {
      // The click that ends a drag is not a pick.
      const swallow = swallowClick;
      swallowClick = false;
      const pick = (event.target as Element).closest<HTMLElement>("[data-am-pick]");
      if (!pick || swallow) return;
      hold();
      pickScene(Number(pick.dataset.amPick));
    };
    // Tab onto a scene selects it, as clicking it does.
    const onFocusIn = (event: FocusEvent) => {
      const pick = (event.target as Element).closest<HTMLElement>("[data-am-pick]");
      if (!pick || !(event.target as HTMLElement).matches(":focus-visible")) return;
      hold();
      pickScene(Number(pick.dataset.amPick));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target !== scrub) return;
      const step = event.shiftKey ? 2 : 0.5;
      const next =
        event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? time - step
          : event.key === "ArrowRight" || event.key === "ArrowUp"
            ? time + step
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? LAST
                : null;
      if (next === null) return;
      event.preventDefault();
      hold();
      pause();
      seek(next);
      select(sceneAt(time));
      window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(play, KEY_RESUME_MS);
    };

    const events: Array<[string, EventListener]> = [
      ["pointerdown", onPointerDown as EventListener],
      ["pointermove", onPointerMove as EventListener],
      ["pointerup", onPointerUp as EventListener],
      ["pointercancel", onPointerCancel],
      ["lostpointercapture", onPointerCancel],
      ["click", onClick as EventListener],
      ["focusin", onFocusIn as EventListener],
      ["keydown", onKeyDown as EventListener],
    ];
    for (const layer of layers) for (const [type, handler] of events) layer.addEventListener(type, handler);

    // ─── When it is live ───────────────────────────────────────────────
    // With reduced motion the hero does not step through its beats: it rests
    // on the finished editor (hero.css), whatever data-beat says.
    const settled = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const beatActive = () =>
      beat === undefined || !scene || settled || !scene.hasAttribute("data-beat") || scene.getAttribute("data-beat") === String(beat);
    let visible = false;
    let active = false;
    const update = () => {
      const now = beatActive();
      if (now !== active) {
        active = now;
        for (const layer of layers) layer.inert = !now;
        window.clearTimeout(demoTimer);
        if (now && beat !== undefined && !settled && scene?.hasAttribute("data-beat")) {
          // Each showing opens the editor afresh: from the top, the AI's
          // selection, and — with motion — the pointer's click on a scene.
          select(initial);
          seek(0);
          if (demoPick !== undefined) {
            demoTimer = window.setTimeout(() => pickScene(demoPick), 450);
          }
        }
      }
      player.wants = visible && active;
      schedule();
    };
    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        player.ratio = entry.intersectionRatio;
        update();
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    io.observe(root);
    const mo = scene ? new MutationObserver(update) : null;
    mo?.observe(scene!, { attributes: true, attributeFilter: ["data-beat"] });
    document.addEventListener("visibilitychange", schedule);
    update();

    return () => {
      io.disconnect();
      mo?.disconnect();
      document.removeEventListener("visibilitychange", schedule);
      for (const layer of layers) for (const [type, handler] of events) layer.removeEventListener(type, handler);
      video.removeEventListener("seeked", onSeeked);
      window.clearTimeout(resumeTimer);
      window.clearTimeout(holdTimer);
      window.clearTimeout(demoTimer);
      scene?.removeAttribute("data-scene-hold");
      player.stop();
      players.delete(player);
      schedule();
    };
  }, [beat, withVideo, demoPick]);

  return <video ref={ref} className="am-video" muted playsInline loop preload="none" aria-hidden="true" tabIndex={-1} />;
}
