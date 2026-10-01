/**
 * Shared by the loading states (server components) and the page-wide client
 * scripts — a plain module, so both sides get the values themselves.
 */

/** The one word every loading state says (and the one screen readers hear). */
export const LOADING_TEXT = "กำลังโหลด";

/** Fired on window when a route loading state gives way to its page (LoadingSignal). */
export const LOADED_EVENT = "noey:loaded";

/** Said from a click on "เปิดห้องตัดต่อ" until the browser leaves for the editor. */
export const EDITOR_OPENING_TEXT = "กำลังเปิดห้องตัดต่อ";
