import { LevelMeter } from "../ds/LevelMeter";
import { LoadingFrame, RenderLoading, Skel, SkelLines } from "../shell/RenderLoading";
import { AccountTabs } from "./AccountTabs";

export type AccountTab = "overview" | "quota" | "billing" | "profile";

/** The tab a path opens ("/account/quota" → "quota"; anything else under /account → "overview"). */
export function accountTabOf(path: string): AccountTab {
  const tab = path.split("?")[0].replace(/^\/account\/?/, "").split("/")[0];
  return tab === "quota" || tab === "billing" || tab === "profile" ? tab : "overview";
}

/*
 * The account tabs while their data is on its way, drawn with the tabs' own
 * classes (account-grid, account-card, the card strips, kv rows, the level
 * meters, the field boxes), so the skeleton has the page's own sizes and the
 * page lands on it without moving. Only what comes from the backend is a
 * bar: the strips' names are the cards' real, fixed names, the meters are
 * real meters left unlit. The centre piece floats over the cards.
 *
 * On the way in, the layout draws the requested tab's skeleton. For a tab
 * switch (app/account/loading.tsx, one loading state for every tab) all four
 * are in the markup and CSS shows the one whose tab is current
 * (`.acct-page__panel:has(.tabs a[aria-current]…)`, account.css), so this
 * stays a server component and the switch needs no script.
 */

function Kicker({ children }: { children: string }) {
  return <div className="card-kicker">{children}</div>;
}

/** A field: its label, its box. */
function Field({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="field">
      <span className="acct-skel__label">
        <Skel w={label} />
      </span>
      <Skel className="skel--box" h="48px" />
      {hint ? (
        <p className="field-hint">
          <Skel w={hint} />
        </p>
      ) : null}
    </div>
  );
}

function OverviewSkeleton({ only = false }: { only?: boolean }) {
  return (
    <div className={only ? "account-grid acct-home acct-skel__tab acct-skel__tab--only" : "account-grid acct-home acct-skel__tab"} data-tab="overview">
      <div className="card account-card acct-hero">
        <Kicker>ห้องตัดต่อ</Kicker>
        <div className="acct-hero__main">
          <div className="acct-hero__copy">
            <h2 className="acct-skel__fill">
              <Skel w="min(15em, 100%)" />
            </h2>
            <p className="acct-skel__fill">
              <SkelLines widths={["100%", "94%", "52%"]} />
            </p>
            {/* The computer-only note's frame (phones and tablets only, by its own rule), its lines as bars. */}
            <p className="computer-only acct-skel__note">
              <SkelLines widths={["96%", "88%", "92%", "40%"]} />
            </p>
            <Skel className="skel--box acct-hero__open" w="220px" h="52px" />
          </div>
          {/* The picture's column, left empty: the centre piece floats here. */}
          <div className="acct-hero__art" />
        </div>
      </div>
      <div className="card account-card acct-summary">
        <Kicker>สรุปบัญชี</Kicker>
        <dl className="kv acct-summary__rows">
          <div>
            <dt>
              <Skel w="6.5em" />
            </dt>
            <dd>
              <Skel w="3em" />
            </dd>
            <dd className="acct-summary__sub">
              <Skel w="9em" />
            </dd>
          </div>
          <div>
            <dt>
              <Skel w="7em" />
            </dt>
            <dd>
              <Skel w="4.5em" />
            </dd>
            <LevelMeter value={0} className="acct-summary__meter" />
          </div>
          <div>
            <dt>
              <Skel w="6em" />
            </dt>
            <dd>
              <Skel w="6.5em" />
            </dd>
            <LevelMeter value={0} className="acct-summary__meter" />
          </div>
        </dl>
      </div>
    </div>
  );
}

function QuotaSkeleton({ only = false }: { only?: boolean }) {
  return (
    <div className={only ? "account-grid acct-quota acct-skel__tab acct-skel__tab--only" : "account-grid acct-quota acct-skel__tab"} data-tab="quota">
      <div className="card account-card">
        <Kicker>รอบปัจจุบัน</Kicker>
        <div className="acct-quota__limit">
          <div className="meter-row">
            <Skel w="7em" />
            <Skel w="4.5em" />
          </div>
          <LevelMeter value={0} />
          <p className="meter-note">
            <Skel w="17em" />
          </p>
        </div>
        <div className="acct-quota__limit acct-quota__limit--storage">
          <div className="meter-row">
            <Skel w="6em" />
            <Skel w="6.5em" />
          </div>
          <LevelMeter value={0} />
          <p className="meter-note">
            <Skel w="10em" />
          </p>
        </div>
      </div>
      <div className="card account-card">
        <Kicker>งานที่ใช้โควตาในรอบนี้</Kicker>
        <Skel className="acct-skel__mix" h="12px" />
        <dl className="kv acct-skel__rows">
          {["15em", "9em", "8em"].map((width) => (
            <div key={width}>
              <dt>
                <Skel w={width} />
              </dt>
              <dd>
                <Skel w="2.2em" />
              </dd>
            </div>
          ))}
        </dl>
        <div className="acct-tasks__foot">
          <p className="meter-note">
            <Skel w="11em" />
          </p>
          <p className="meter-note acct-tasks__note">
            <Skel w="22em" />
          </p>
        </div>
      </div>
    </div>
  );
}

function BillingSkeleton({ only = false }: { only?: boolean }) {
  return (
    <div className={only ? "account-grid acct-billing acct-skel__tab acct-skel__tab--only" : "account-grid acct-billing acct-skel__tab"} data-tab="billing">
      <div className="card account-card acct-plan">
        <Kicker>แพลนปัจจุบัน</Kicker>
        <div className="plan-body">
          <div className="plan-main">
            <div className="plan-head">
              <span className="plan-name">
                <Skel w="4.5em" />
              </span>
            </div>
            <div className="plan-price">
              <span className="num plan-price__value">
                <Skel w="2.4em" />
              </span>
              <span className="plan-price__unit">
                <Skel w="4.5em" />
              </span>
            </div>
            <div className="plan-usage">
              <p className="plan-usage__basis">
                <SkelLines widths={["100%", "62%"]} />
              </p>
            </div>
          </div>
          <ul className="plan-features acct-skel__list">
            {["92%", "80%", "70%", "86%", "60%"].map((width) => (
              <li key={width}>
                <Skel w={width} />
              </li>
            ))}
          </ul>
        </div>
        <div className="button-row">
          <Skel className="skel--box" w="7.5em" h="44px" />
        </div>
      </div>
      <div className="card account-card acct-pay">
        <Kicker>การชำระเงิน</Kicker>
        <div className="acct-cycle">
          <div className="acct-cycle__top">
            <Skel w="4.5em" />
            <Skel w="7em" />
          </div>
          <div className="acct-cycle__lane" />
          <div className="acct-cycle__ends">
            <Skel w="3.5em" />
            <Skel w="3.5em" />
          </div>
        </div>
        <dl className="kv">
          <div>
            <dt>
              <Skel w="6em" />
            </dt>
            <dd>
              <Skel w="7em" />
            </dd>
          </div>
          <div>
            <dt>
              <Skel w="7em" />
            </dt>
            <dd>
              <Skel w="4em" />
            </dd>
          </div>
        </dl>
        <Skel className="skel--box acct-pay__btn" w="7em" h="44px" />
      </div>
    </div>
  );
}

function ProfileSkeleton({ only = false }: { only?: boolean }) {
  return (
    <div className={only ? "account-grid acct-profile acct-skel__tab acct-skel__tab--only" : "account-grid acct-profile acct-skel__tab"} data-tab="profile">
      <div className="card account-card">
        <Kicker>ข้อมูลส่วนตัว</Kicker>
        <div className="stack acct-form acct-form--inline">
          <Field label="2em" />
          <Skel className="skel--box acct-form__submit" w="9em" h="48px" />
        </div>
        <div className="card-section">
          <h3>
            <Skel w="10em" />
          </h3>
          <div className="stack acct-form">
            <Field label="3em" hint="22em" />
            <Field label="7em" hint="17em" />
            <Skel className="skel--box acct-form__submit" w="8em" h="44px" />
          </div>
        </div>
      </div>
      <div className="card account-card">
        <Kicker>ความปลอดภัย</Kicker>
        <h3 className="acct-subhead">
          <Skel w="4.5em" />
        </h3>
        <div className="stack acct-form">
          <Field label="7.5em" />
          <Field label="6em" hint="9em" />
          <Skel className="skel--box acct-form__submit" w="9em" h="44px" />
        </div>
      </div>
      <div className="card account-card danger-zone acct-danger">
        <div className="acct-danger__copy">
          <h3>
            <Skel w="4em" />
          </h3>
          <p>
            <SkelLines widths={["100%", "64%"]} />
          </p>
        </div>
        <div className="danger-zone__action">
          <Skel className="skel--box" w="8em" h="44px" />
        </div>
      </div>
    </div>
  );
}

/**
 * The inside of the account panel while a tab's data loads (app/account/
 * loading.tsx when switching tabs; the layout's own fallback on the way in).
 */
export function AccountBodySkeleton({ demo = false, tab }: { demo?: boolean; tab?: AccountTab }) {
  return (
    <LoadingFrame className="acct-skel" demo={demo}>
      <RenderLoading variant="chip" className="acct-skel__centre" />
      <div className="acct-skel__tabs" aria-hidden="true">
        {tab === "overview" ? <OverviewSkeleton only /> : tab ? null : <OverviewSkeleton />}
        {tab === "quota" ? <QuotaSkeleton only /> : tab ? null : <QuotaSkeleton />}
        {tab === "billing" ? <BillingSkeleton only /> : tab ? null : <BillingSkeleton />}
        {tab === "profile" ? <ProfileSkeleton only /> : tab ? null : <ProfileSkeleton />}
      </div>
    </LoadingFrame>
  );
}

/**
 * The whole panel (its tabs are the real, working tabs) — the layout's
 * fallback while the account is read. The layout knows the tab from the
 * request, so it draws that tab's skeleton only.
 */
export function AccountPanelSkeleton({ demo = false, tab }: { demo?: boolean; tab?: AccountTab }) {
  return (
    <div className="acct-page__panel">
      <AccountTabs />
      <div className="acct-page__body">
        <AccountBodySkeleton demo={demo} tab={tab} />
      </div>
    </div>
  );
}
