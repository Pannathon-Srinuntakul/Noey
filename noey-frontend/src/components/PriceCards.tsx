import Link from "next/link";
import { BETA_BADGE, BETA_STRIKE_LABEL, isBetaActive } from "@/lib/beta";
import {
  APPROX_CUTS_PER_MONTH,
  CLIPS_BASIS_SHORT,
  CLIPS_FOOTNOTE,
  CUTS_APPROX_PREFIX,
  CUTS_APPROX_SHORT,
  EXTRA_TIERS,
  FREE_CLIPS_CAPTION,
  MAIN_TIERS,
  PAID_TIERS,
  PLAN_COPY,
  clipsHeadline,
  clipsHighLine,
  displayPrice,
  strikePrice,
  type PriceTable,
  type Tier,
} from "@/lib/plans";
import { PlanButton } from "./PlanButton";

/**
 * The full price, struck through, immediately before the beta price and on the
 * SAME line so the row does not grow taller. `strikePrice` returns null once
 * the beta ends, which is what makes the cards revert on their own.
 */
function StrikeThrough({ table, tier }: { table: PriceTable; tier: Tier }) {
  const full = strikePrice(table, tier);
  if (!full) return null;
  return (
    <s className="num price-strike">
      <span className="sr-only">{BETA_STRIKE_LABEL} </span>
      {full}
    </s>
  );
}

type CardSize = "home" | "full" | "extra";

/**
 * The plan cards. `variant="home"` is the compact strip on the home page
 * (the four main plans as cards, then Lite / Agency / Max as a short list);
 * `variant="full"` is /pricing (feature bullets, the four main plans, then
 * Lite / Agency / Max as smaller cards in a second section).
 * Prices come from the shared PriceTable; a paid tier the backend does not
 * list shows no invented price and cannot be bought.
 */
export function PriceCards({ table, variant }: { table: PriceTable; variant: "home" | "full" }) {
  const full = variant === "full";
  return (
    <>
      <div className={full ? "price-grid price-grid--full" : "price-grid"}>
        {MAIN_TIERS.map((tier) => (
          <PriceCard key={tier} tier={tier} table={table} size={full ? "full" : "home"} />
        ))}
      </div>
      {/* Said once for the page; each card carries only the short basis. */}
      <p className="clip-note clip-note--grid">{CLIPS_FOOTNOTE}</p>
      {full ? (
        <section className="price-extra" aria-labelledby="price-extra-title">
          <div className="price-extra__head">
            <h2 id="price-extra-title" className="price-extra__title">
              แพลนเพิ่มเติม
            </h2>
            <p className="price-extra__note">Lite สำหรับเริ่มแบบประหยัด · Agency และ Max สำหรับทีมและเอเจนซีที่ผลิตคลิปทุกวัน</p>
          </div>
          <div className="price-grid price-grid--extra">
            {EXTRA_TIERS.map((tier) => (
              <PriceCard key={tier} tier={tier} table={table} size="extra" />
            ))}
          </div>
        </section>
      ) : (
        <div className="price-more">
          <div className="price-more__head">
            <h3 className="price-more__title">แพลนเพิ่มเติม</h3>
            <p className="price-more__note">Lite สำหรับเริ่มแบบประหยัด · Agency และ Max สำหรับทีมและเอเจนซีที่ผลิตคลิปทุกวัน</p>
          </div>
          <div className="price-more__grid">
            {EXTRA_TIERS.map((tier) => {
              const price = displayPrice(table, tier);
              const high = clipsHighLine(tier);
              return (
                <div key={tier} className="price-more__item">
                  <div className="price-more__name">
                    <span>{PLAN_COPY[tier].name}</span>
                    <span className="num price-more__mult">{clipsHeadline(tier)}</span>
                  </div>
                  {high ? <p className="num price-more__high">{high}</p> : null}
                  <div className="num price-more__price">
                    {price ? (
                      <>
                        <StrikeThrough table={table} tier={tier} />
                        {`${price} บาท / เดือน`}
                      </>
                    ) : (
                      "—"
                    )}
                  </div>
                  <p className="price-more__blurb">{PLAN_COPY[tier].homeBlurb}</p>
                </div>
              );
            })}
          </div>
          <p className="clip-note clip-note--group">{CLIPS_FOOTNOTE}</p>
        </div>
      )}
    </>
  );
}

function PriceCard({ tier, table, size }: { tier: Tier; table: PriceTable; size: CardSize }) {
  const copy = PLAN_COPY[tier];
  const price = displayPrice(table, tier);
  const detailed = size !== "home";
  const classes = ["card", "price-card", `price-card--${size}`];
  if (copy.recommended) classes.push("price-card--recommended", "elev-sm");
  const paid = (PAID_TIERS as readonly string[]).includes(tier);
  // Only a plan whose price is actually discounted carries the badge.
  const beta = isBetaActive() && strikePrice(table, tier) !== null;

  // The headline: an APPROXIMATE cut count, never a token count and never
  // minutes of footage. The "ราว" is part of the claim, not decoration — a
  // heavy user gets fewer — so it sits with the number, not in a footnote.
  // Free is one trial credit, so it carries its own caption instead of /เดือน.
  const cuts = APPROX_CUTS_PER_MONTH[tier];
  const cutsPrefix = tier === "free" ? CUTS_APPROX_SHORT : CUTS_APPROX_PREFIX;
  const cutsUnit = tier === "free" ? "คลิป" : "คลิป / เดือน";
  // Pro and up: the same count at ระดับละเอียด, rounded down like the first.
  const high = clipsHighLine(tier);

  return (
    <div className={classes.join(" ")}>
      {copy.recommended ? (
        <div className="price-card__head">
          <div className="card-kicker">{copy.name}</div>
          <span className="tag tag-outline">แนะนำ</span>
        </div>
      ) : (
        <div className="card-kicker">{copy.name}</div>
      )}
      <div className="price-card__amount">
        <StrikeThrough table={table} tier={tier} />
        <span className="num price-card__value">{price ?? "—"}</span>
        <span className="price-card__unit">{tier === "free" ? "บาท" : "บาท / เดือน"}</span>
      </div>
      {beta ? <p className="price-card__beta">{BETA_BADGE} · ลด 50% ถึง 31 ธ.ค. 2026 จากนั้นคิดราคาปกติ</p> : null}
      <div className="price-card__usage">
        <span className="usage-approx">{cutsPrefix}</span>
        <span className="num usage-mult">{cuts}</span>
        <span className="usage-caption">{tier === "free" ? `${cutsUnit} · ${FREE_CLIPS_CAPTION}` : cutsUnit}</span>
        {high ? <span className="usage-high">{high}</span> : null}
      </div>
      <p className="clip-note">{CLIPS_BASIS_SHORT}</p>
      <p className="card-body">{detailed ? copy.pricingBlurb : copy.homeBlurb}</p>
      {detailed ? (
        <ul className="price-card__features">
          {copy.features.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
      ) : null}
      <div className="price-card__foot">
        {paid ? (
          <PlanButton
            tier={tier as (typeof PAID_TIERS)[number]}
            label={detailed ? copy.pricingCta : "เลือกแพลนนี้"}
            primary={!!copy.recommended}
            disabled={price === null}
          />
        ) : (
          <Link href="/signup" className="btn btn-secondary btn-block">
            เริ่มใช้ฟรี
          </Link>
        )}
      </div>
    </div>
  );
}
