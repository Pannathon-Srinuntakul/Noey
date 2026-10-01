import { EDITOR_OPENING_TEXT } from "@/lib/loading";
import { NoeyMark } from "../NoeyMark";
import { WaitClock } from "./RenderLoading";

/**
 * "กำลังเปิดห้องตัดต่อ": every "เปิดห้องตัดต่อ" link goes through
 * EDITOR_OPEN_PATH, where the server mints a one-time code before sending the
 * browser on, which takes a moment. From the click until the browser leaves,
 * this render card covers the page: the mark, a render bar running (still:
 * full and dimmed), the wait clock and the words.
 *
 * Static markup in every page, shown by <html data-editor-opening>
 * (EditorOpenWatch in the header sets it, and drops it on `pagehide` /
 * `pageshow`, so a page restored by Back never keeps it). The links stay
 * plain, unprefetched <a> elements; without JavaScript they simply navigate.
 * The status line below is filled in on the click, so screen readers hear it.
 */
export function EditorOpenOverlay() {
  return (
    <>
      <div className="edopen" aria-hidden="true">
        <EditorOpenPanel />
      </div>
      <p className="sr-only" role="status" aria-live="polite" data-editor-status="" />
    </>
  );
}

/** The render card itself (`demo`: running on its own, for the kitchen sink). */
export function EditorOpenPanel({ demo = false }: { demo?: boolean }) {
  return (
    <div className="edopen__panel" data-demo={demo ? "" : undefined}>
      <div className="edopen__strip">
        <span className="edopen__rec" />
        <span className="tc edopen__state">RENDERING</span>
        <span className="edopen__rule" />
        <WaitClock />
      </div>
      <NoeyMark size={56} strokeWidth={11} draw split className="edopen__mark" />
      <span className="edopen__bar">
        <i />
      </span>
      <p className="edopen__text">{EDITOR_OPENING_TEXT}</p>
    </div>
  );
}
