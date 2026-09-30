"use client";

import { BETA_BANNER_LINK } from "@/lib/beta";
import { BETA_OPEN_EVENT } from "./BetaNotice";

/** "รายละเอียด": reopens the beta notice (BetaNotice listens for the event). */
export function BetaBannerButton() {
  return (
    <button
      type="button"
      className="link-button beta-banner__more"
      onClick={(event) => window.dispatchEvent(new CustomEvent(BETA_OPEN_EVENT, { detail: event.currentTarget }))}
    >
      {BETA_BANNER_LINK}
    </button>
  );
}
