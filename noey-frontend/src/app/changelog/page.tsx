import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumb } from "@/components/Breadcrumb";
import { JsonLd } from "@/components/JsonLd";
import { IconArrowRight } from "@/components/ds/icons";
import { PageHero } from "@/components/ds/PageHero";
import { keepThaiProse } from "@/components/ds/ThaiProse";
import { CHANGELOG, CHANGE_KIND_LABEL, type ChangelogEntry } from "@/lib/changelog";
import { CHANGELOG_FEED_PATH } from "@/lib/changelog-feed";
import { formatThaiDate } from "@/lib/format";
import { breadcrumbNode, jsonLdGraph, webPageNode } from "@/lib/jsonld";
import { pageMetadata } from "@/lib/seo";
import { PAGES } from "@/lib/site";
import "../../styles/pages/changelog.css";

export const metadata: Metadata = pageMetadata("changelog");

const TRAIL = [
  { name: PAGES.home.label, path: PAGES.home.path },
  { name: PAGES.changelog.label, path: PAGES.changelog.path },
];

const monthLabel = (isoDate: string) =>
  new Intl.DateTimeFormat("th-TH", { month: "long", year: "numeric", timeZone: "Asia/Bangkok" }).format(new Date(`${isoDate}T00:00:00+07:00`));

/** Entries grouped by month, keeping their newest-first order. */
function byMonth(entries: readonly ChangelogEntry[]) {
  const groups: { key: string; label: string; entries: ChangelogEntry[] }[] = [];
  for (const entry of entries) {
    const key = entry.date.slice(0, 7);
    const last = groups[groups.length - 1];
    if (last?.key === key) last.entries.push(entry);
    else groups.push({ key, label: monthLabel(entry.date), entries: [entry] });
  }
  return groups;
}

/**
 * /changelog — what changed, newest first, as a timeline: a rail with a cue
 * per change, the date as the cue's label, a tag for its kind. Data:
 * lib/changelog.ts.
 */
export default function ChangelogPage() {
  const page = PAGES.changelog;
  return (
    <main id="main" className="changelog-page">
      <PageHero
        crumb={<Breadcrumb trail={TRAIL} />}
        title="มีอะไรใหม่"
        lead={<p>{keepThaiProse("ฟีเจอร์ใหม่ การปรับปรุง และการเปลี่ยนแปลงราคาของ Noey Studio เรียงจากล่าสุด")}</p>}
        meta={
          <p className="stamp">
            อัปเดตล่าสุด <time dateTime={page.updated}>{formatThaiDate(page.updated)}</time>
          </p>
        }
      />

      <div className="wrap changelog">
        {byMonth(CHANGELOG).map((group) => (
          <section key={group.key} className="changelog__month" aria-labelledby={`month-${group.key}`}>
            <h2 id={`month-${group.key}`} className="changelog__month-title">
              {group.label}
            </h2>
            <ol className="changelog__list">
              {group.entries.map((entry) => (
                <li key={entry.id} className="change">
                  <article id={entry.id} className="change__body" aria-labelledby={`${entry.id}-title`}>
                    <div className="change__cue">
                      <span className="change__dot" aria-hidden="true" />
                      <time className="change__date" dateTime={entry.date}>
                        {formatThaiDate(entry.date)}
                      </time>
                      <span className={`change__kind change__kind--${entry.kind}`}>{CHANGE_KIND_LABEL[entry.kind]}</span>
                    </div>
                    <h3 id={`${entry.id}-title`} className="change__title">
                      <a href={`#${entry.id}`} className="change__anchor">
                        {keepThaiProse(entry.title)}
                      </a>
                    </h3>
                    {entry.body.map((paragraph) => (
                      <p key={paragraph} className="change__text">
                        {keepThaiProse(paragraph)}
                      </p>
                    ))}
                    {entry.plans ? <p className="change__plans">{keepThaiProse(entry.plans)}</p> : null}
                    {entry.link ? (
                      <p className="change__more">
                        <Link href={entry.link.href}>
                          <span>{keepThaiProse(entry.link.label)}</span>
                          <IconArrowRight size={15} />
                        </Link>
                      </p>
                    ) : null}
                  </article>
                </li>
              ))}
            </ol>
          </section>
        ))}

        <p className="changelog__feed">
          <a href={CHANGELOG_FEED_PATH}>ติดตามผ่าน RSS/Atom</a>
        </p>
      </div>

      <JsonLd
        data={jsonLdGraph(
          webPageNode({ path: page.path, name: page.title, description: page.description, dateModified: page.updated }),
          breadcrumbNode(TRAIL),
        )}
      />
    </main>
  );
}
