import { EDITOR_CARD_HTML } from "@/lib/client/editor-card";

/**
 * "กำลังเปิดห้องตัดต่อ": every "เปิดห้องตัดต่อ" link goes through
 * EDITOR_OPEN_PATH, where the server mints a one-time code before sending the
 * browser on, which takes a moment. From the click until the browser leaves,
 * a render card covers the page: the mark, a render bar running (still: full
 * and dimmed), the wait clock and the words. On a click the header
 * (useEditorOpening in HeaderClient) builds it from the same markup
 * (lib/client/editor-card.ts), so no page's HTML carries it. This draws it
 * on its own, for the kitchen sink (`demo`: running). Its styles are in
 * loading-deferred.css.
 */
export function EditorOpenPanel({ demo = false }: { demo?: boolean }) {
  return <div className="edopen__panel" data-demo={demo ? "" : undefined} dangerouslySetInnerHTML={{ __html: EDITOR_CARD_HTML }} />;
}
