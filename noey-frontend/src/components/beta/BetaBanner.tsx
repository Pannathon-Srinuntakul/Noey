import { BETA_BADGE } from "@/lib/beta";
import { BetaBannerButton } from "./BetaBannerButton";

/**
 * The slim strip pinned above the header for the rest of the beta. Rendered
 * on the server (the root layout decides with `shouldShowBetaBanner()`), so
 * it is in the first paint and never pushes the page down after load; the
 * modal (BetaNotice) takes it down on the client if the date has passed.
 */
export function BetaBanner({ text }: { text: string }) {
  return (
    <div className="beta-banner" data-beta-strip="">
      <span className="tag tag-accent beta-banner__badge">{BETA_BADGE}</span>
      <span className="beta-banner__text">{text}</span>
      <BetaBannerButton />
    </div>
  );
}
