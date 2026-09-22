import Link from "next/link";
import {
  EXTRA_TIERS,
  MAIN_TIERS,
  PAID_TIERS,
  PLAN_COPY,
  displayPrice,
  multiplierCaption,
  multiplierLabel,
  type PriceTable,
  type Tier,
} from "@/lib/plans";
import { PlanButton } from "./PlanButton";

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
              return (
                <div key={tier} className="price-more__item">
                  <div className="price-more__name">
                    <span>{PLAN_COPY[tier].name}</span>
                    <span className="num price-more__mult">{multiplierLabel(tier)}</span>
                  </div>
                  <div className="num price-more__price">{price ? `${price} บาท / เดือน` : "—"}</div>
                  <p className="price-more__blurb">{PLAN_COPY[tier].homeBlurb}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}

function PriceCard({ tier, table, size }: { tier: Tier; table: PriceTable; size: CardSize }) {
  const copy = PLAN_COPY[tier];
  const price = displayPrice(table, tier);
  const multiplier = multiplierLabel(tier);
  const detailed = size !== "home";
  const classes = ["card", "price-card", `price-card--${size}`];
  if (copy.recommended) classes.push("price-card--recommended", "elev-sm");
  const paid = (PAID_TIERS as readonly string[]).includes(tier);

  // Usage is sold as a multiple of Lite — never as a token count. The free plan
  // has no multiple: it is the trial, and it does not expire.
  const usageValue = multiplier ?? "ทดลองใช้";
  const usageCaption = multiplier === null ? "ไม่หมดอายุ" : size === "home" ? "ของ Lite" : multiplierCaption(tier);

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
        <span className="num price-card__value">{price ?? "—"}</span>
        <span className="price-card__unit">{tier === "free" ? "บาท" : "บาท / เดือน"}</span>
      </div>
      <div className="price-card__usage">
        <span className="num usage-mult">{usageValue}</span>
        <span className="usage-caption">{usageCaption}</span>
      </div>
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
