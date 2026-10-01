import { EDITOR_OPENING_TEXT } from "../loading";

/**
 * The "กำลังเปิดห้องตัดต่อ" render card's markup (styles: loading-deferred.css):
 * a title strip (a light, the render
 * queue's word, a rule, the wait clock), the splice mark in its two halves
 * (NoeyMark's geometry at the status cards' lighter stroke: the gap stays
 * open), the render bar and the words.
 */
export const EDITOR_CARD_HTML =
  '<div class="edopen__strip"><span class="edopen__rec"></span><span class="tc edopen__state">RENDERING</span>' +
  '<span class="edopen__rule"></span><span class="tc ld-tc"></span></div>' +
  '<svg class="mark-draw edopen__mark" width="56" height="56" viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="11" stroke-linecap="round" aria-hidden="true" focusable="false">' +
  '<g class="mark-half mark-half--l"><path d="M22 78 V 22" pathLength="1"/><path d="M22 22 L 44 55" pathLength="1"/></g>' +
  '<g class="mark-half mark-half--r"><path d="M56 45 L 78 78" pathLength="1"/><path d="M78 78 V 22" pathLength="1"/></g></svg>' +
  `<span class="edopen__bar"><i></i></span><p class="edopen__text">${EDITOR_OPENING_TEXT}</p>`;

/** Puts the card on the page; (re)inserted, so its appear delay and clock start now. */
export function showEditorCard(): void {
  let card = document.querySelector<HTMLDivElement>("body > .edopen");
  if (!card) {
    card = document.createElement("div");
    card.className = "edopen";
    card.setAttribute("aria-hidden", "true");
    card.innerHTML = `<div class="edopen__panel">${EDITOR_CARD_HTML}</div>`;
  }
  document.body.append(card);
}
