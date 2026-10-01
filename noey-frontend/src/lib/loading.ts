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

/**
 * Without JavaScript, React cannot move streamed content into place: a page
 * whose data arrives after its loading state (the account, verification,
 * checkout) streams that content in hidden `<div hidden id="S:n">` blocks at
 * the end of <body>, and the inline script that would swap each one for its
 * loading state (`<template id="B:n">` + the fallback after it) never runs.
 * This style (in a <noscript>, so only then) keeps each loading state until
 * its own content has arrived, then hides it and shows the content where it
 * landed — above the footer, by flex order. The page reads complete, in
 * order, if not in its exact layout. Pages with nothing streamed (every
 * static page) are untouched. The header ruler, which turns pending while a
 * loading state is in the page, keeps its ordinary face: here a loading
 * state stays in the DOM, hidden, after its content has come.
 */
export const NOSCRIPT_STREAM_CSS = [
  'body:has(> div[hidden][id^="S:"]){display:flex;flex-direction:column}',
  'body:has(> div[hidden][id^="S:"]) > [data-site-footer]{order:1}',
  'div[hidden][id^="S:"]{display:contents}',
  Array.from({ length: 16 }, (_, n) => `body:has(#S\\:${n}) #B\\:${n} + *`).join(",") + "{display:none}",
  ".stl__scrub,.stl__wait{display:none}",
  ".stl__tc,.stl__fill,.stl__playhead{opacity:1!important;scale:none!important}",
].join("");
