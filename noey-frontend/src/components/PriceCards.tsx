import Link from "next/link";
import { BETA_BADGE, BETA_DISCOUNT_PERCENT, BETA_STRIKE_LABEL, isBetaActive } from "@/lib/beta";
import {
  APPROX_CUTS_PER_MONTH,
  APPROX_HIGH_CUTS_PER_MONTH,
  CUTS_APPROX_SHORT,
  CUTS_NO_FINE,
  CUTS_OVER_FOOTAGE,
  CUTS_SHORT_OF_BUDGET,
  EXTRA_TIERS,
  FOOTAGE_PER_PROJECT,
  MAIN_TIERS,
  PAID_TIERS,
  PLAN_COPY,
  PRECISION_NAMES,
  TIERS,
  displayPrice,
  strikePrice,
  type PriceTable,
  type Tier,
} from "@/lib/plans";
import { PlanButton } from "./PlanButton";
import { CutsCount, CutsNumber, CutsWord } from "./pricing/CutsCount";
import "../styles/parts/plans.css";
import { keepThaiProse } from "./ds/ThaiProse";

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

type CardSize = "home" | "full";

const EXTRA_NOTE = "Lite สำหรับเริ่มแบบประหยัด · Agency และ Max สำหรับทีมและเอเจนซีที่ผลิตคลิปทุกวัน";

/** Reel number on each card: the plan's place in the ladder (decoration). */
const REEL: Record<Tier, string> = { free: "P0", lite: "P1", starter: "P2", pro: "P3", studio: "P4", agency: "P5", max: "P6" };

/**
 * The plan cards. `variant="home"` is the home page strip (the four main
 * plans as cards, then Lite / Agency / Max as a short list), with no clip
 * counts: a count is pinned to one mode and raw-clip length, so it appears on
 * /pricing's calculator only (owner, 2026-10-01). `variant="full"
 * is /pricing: all seven plans, cheapest first, on one horizontal rail that
 * snaps card by card (PlanRail adds the controls and the clips-per-month
 * picker); Lite, Agency and Max carry the "แพลนเพิ่มเติม" tag, explained by
 * the note under the rail.
 * Prices come from the shared PriceTable; a paid tier the backend does not
 * list shows no invented price and cannot be bought.
 */
export function PriceCards({
  table,
  variant,
  fit = null,
}: {
  table: PriceTable;
  variant: "home" | "full";
  /** /pricing: the plan the calculator answers with at its default, marked in the HTML (PlanRail moves it). */
  fit?: Tier | null;
}) {
  if (variant === "full") {
    return (
      <>
        <ol className="plan-rail__track" data-rail-track="">
          {TIERS.map((tier) => (
            <li key={tier} className="plan-rail__slot">
              <PriceCard tier={tier} table={table} size="full" fit={fit === tier} />
            </li>
          ))}
        </ol>
        {/* The basis of every count is said once, beside the calculator's
            answer (PlanRail); the cards carry none of their own here. */}
        {/* The legend for the tag three of the cards carry: the tag itself,
            then what it means. */}
        <p className="price-extra">
          <span className="tag tag-neutral price-extra__tag">แพลนเพิ่มเติม</span>
          <span className="price-extra__note">{keepThaiProse(EXTRA_NOTE)}</span>
        </p>
      </>
    );
  }

  return (
    <>
      <div className="price-grid" data-reveal="stagger">
        {MAIN_TIERS.map((tier) => (
          <PriceCard key={tier} tier={tier} table={table} size="home" />
        ))}
      </div>
      <div className="price-more">
        <div className="price-more__head">
          <h3 className="price-more__title">แพลนเพิ่มเติม</h3>
          <p className="price-more__note">{keepThaiProse(EXTRA_NOTE)}</p>
        </div>
        <div className="price-more__grid">
          {EXTRA_TIERS.map((tier) => {
            const price = displayPrice(table, tier);
            return (
              <div key={tier} className="price-more__item">
                <div className="price-more__name">
                  <span className="price-more__plan">{PLAN_COPY[tier].name}</span>
                </div>
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
                <p className="price-more__blurb">{keepThaiProse(PLAN_COPY[tier].homeBlurb)}</p>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

function PriceCard({ tier, table, size, fit = false }: { tier: Tier; table: PriceTable; size: CardSize; fit?: boolean }) {
  const copy = PLAN_COPY[tier];
  const price = displayPrice(table, tier);
  const detailed = size === "full";
  const extra = (EXTRA_TIERS as readonly string[]).includes(tier);
  const classes = ["plan", `plan--${size}`];
  if (copy.recommended) classes.push("plan--recommended");
  if (extra) classes.push("plan--extra");
  const paid = (PAID_TIERS as readonly string[]).includes(tier);
  // Only a plan whose price is actually discounted carries the badge.
  const beta = isBetaActive() && strikePrice(table, tier) !== null;

  // /pricing's headline: an APPROXIMATE cut count, never a token count and
  // never minutes of footage. The "ราว" is part of the claim, not decoration —
  // a heavy user gets fewer — so it sits with the number, not in a footnote.
  // Free is one trial credit, so it says "คลิป" instead of "คลิป / เดือน".
  // The count and its words are marked (pricing/CutsCount) so the calculator
  // can reprice them for another mode or length. The home strip shows none.
  const free = tier === "free";
  const cuts = APPROX_CUTS_PER_MONTH[tier];
  // Pro and up: the same count at ระดับละเอียด, rounded down like the first.
  const highCuts = APPROX_HIGH_CUTS_PER_MONTH[tier];

  return (
    <article className={classes.join(" ")} data-tier={tier} data-fit={fit ? "" : undefined} aria-labelledby={`plan-${size}-${tier}`}>
      {/* /pricing's one answer: shown on the card that fits the calculator
          (PlanRail moves [data-fit]); a marker on the card's top edge. */}
      {detailed && paid ? <span className="tag plan__fit-tag">พอดีกับที่เลือก</span> : null}
      <div className="plan__head">
        {/* The reel number on /pricing, where the whole ladder is in view; the
            home strip shows four plans out of order with the ladder's others
            below, so codes there read as gaps. */}
        {detailed ? (
          <span className="trk tc" aria-hidden="true">
            {REEL[tier]}
          </span>
        ) : null}
        <h3 className="plan__name" id={`plan-${size}-${tier}`}>
          {copy.name}
        </h3>
        {copy.recommended ? <span className="tag tag-outline plan__tag plan__tag--rec">แนะนำ</span> : null}
        {detailed && extra ? <span className="tag tag-neutral plan__tag">แพลนเพิ่มเติม</span> : null}
      </div>
      <div className="plan__amount">
        <StrikeThrough table={table} tier={tier} />
        <span className="num plan__value" data-countup={detailed && price && price !== "0" ? price : undefined} data-reveal={detailed ? "count" : undefined}>
          <span data-countup-value="">{price ?? "—"}</span>
        </span>
        <span className="plan__unit">{tier === "free" ? "บาท" : "บาท / เดือน"}</span>
      </div>
      {/* The terms are said in full once, in the strip above the cards
          (BetaPriceNote); the card shows the struck regular price and this. */}
      {beta ? (
        <p className="plan__beta">
          <span className="tag tag-accent">{`${BETA_BADGE} −${BETA_DISCOUNT_PERCENT}%`}</span>
        </p>
      ) : !detailed && isBetaActive() ? (
        // The home strip's free card keeps the chip's row, unpainted, so the
        // four cards' rows line up across the strip.
        <p className="plan__beta plan__beta--blank" aria-hidden="true">
          <span className="tag">&nbsp;</span>
        </p>
      ) : null}
      {detailed ? (
        <p className="plan__usage">
          {/* The headline: the setting the calculator has picked (ระดับปกติ
              until it says otherwise); the second line, Pro and up: the other
              setting, quieter. Both rounded down. */}
          <CutsCount
            tier={tier}
            slot="primary"
            over={<span className="usage-over">{`${CUTS_OVER_FOOTAGE} (${FOOTAGE_PER_PROJECT[tier]})`}</span>}
            short={<span className="usage-over">{CUTS_SHORT_OF_BUDGET}</span>}
            none={<span className="usage-over">{CUTS_NO_FINE}</span>}
          >
            <span className="usage-approx">
              <CutsWord word={free ? "hedge" : "prefix"} />
            </span>{" "}
            <span className="usage-count">
              <CutsNumber className="num usage-mult" value={cuts} />{" "}
              <span className="usage-caption">
                <CutsWord word={free ? "unit" : "unit-month"} />
              </span>
            </span>
            <span className="usage-setting" data-cuts-setting-tag="" hidden>
              {`ระดับ${PRECISION_NAMES.high}`}
            </span>
          </CutsCount>
          {/* /pricing says the free plan's one-off nature once, in its blurb. */}
          {highCuts ? (
            <CutsCount tier={tier} precision="high" slot="secondary" className="usage-high">
              ระดับ<span data-cuts-setting-word="">{PRECISION_NAMES.high}</span>
              <span className="usage-count">
                {`${CUTS_APPROX_SHORT} `}
                <CutsNumber value={highCuts} /> คลิป
              </span>
            </CutsCount>
          ) : null}
        </p>
      ) : null}
      <p className="plan__blurb">{keepThaiProse(detailed ? copy.pricingBlurb : copy.homeBlurb)}</p>
      {detailed ? (
        <ul className="plan__features">
          {copy.features.map((feature) => (
            <li key={feature}>{keepThaiProse(feature)}</li>
          ))}
        </ul>
      ) : null}
      <div className="plan__foot">
        {paid ? (
          <PlanButton
            tier={tier as (typeof PAID_TIERS)[number]}
            label={detailed ? copy.pricingCta : "เลือกแพลนนี้"}
            // /pricing: no card is gold by itself; the plan that fits wears
            // the gold action (plans.css, [data-fit]). Home: Pro, as before.
            primary={!detailed && !!copy.recommended}
            disabled={price === null}
          />
        ) : (
          <Link href="/signup" className="btn btn-secondary btn-block">
            เริ่มใช้ฟรี
          </Link>
        )}
      </div>
    </article>
  );
}
