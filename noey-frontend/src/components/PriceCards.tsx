import Link from "next/link";
import { PAID_TIERS, PLAN_COPY, TIERS, displayPrice, type PriceTable, type Tier } from "@/lib/plans";
import { PlanButton } from "./PlanButton";

/**
 * The five plan cards. `variant="home"` is the compact strip on the home page
 * (blurb only); `variant="full"` is /pricing (feature bullets). Prices come
 * from the shared PriceTable; a paid tier the backend does not list shows no
 * invented price and cannot be bought.
 */
export function PriceCards({ table, variant }: { table: PriceTable; variant: "home" | "full" }) {
  const full = variant === "full";
  return (
    <div className={full ? "price-grid price-grid--full" : "price-grid"}>
      {TIERS.map((tier) => (
        <PriceCard key={tier} tier={tier} table={table} full={full} />
      ))}
    </div>
  );
}

function PriceCard({ tier, table, full }: { tier: Tier; table: PriceTable; full: boolean }) {
  const copy = PLAN_COPY[tier];
  const price = displayPrice(table, tier);
  const classes = ["card", "price-card"];
  if (!full) classes.push("price-card--home");
  if (copy.recommended) classes.push("price-card--recommended", "elev-sm");
  const paid = (PAID_TIERS as readonly string[]).includes(tier);

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
      <p className="card-body">{full ? copy.pricingBlurb : copy.homeBlurb}</p>
      {full ? (
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
            label={full ? copy.pricingCta : "เลือกแพลนนี้"}
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
