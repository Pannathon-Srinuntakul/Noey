import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOME_FAQ, PRICING_FAQ } from "./faq";
import { APP_ICONS } from "./icons";
import {
  breadcrumbNode,
  faqPageNode,
  jsonLdGraph,
  organizationNode,
  serializeJsonLd,
  softwareApplicationNode,
  webPageNode,
} from "./jsonld";
import { buildLlmsTxt, buildPricingMarkdown } from "./machine-readable";
import { fallbackPriceTable, normalizePlansResponse, PLAN_COPY } from "./plans";
import { robotsRules } from "./crawl";
import { PAGES_WITH_OWN_OG_IMAGE, pageMetadata, tokenPageMetadata } from "./seo";
import { LEGAL_PAGES_ARE_DRAFTS, PAGES, type PageKey } from "./site";

const keys = Object.keys(PAGES) as PageKey[];

describe("page registry (titles, descriptions, canonicals)", () => {
  it("keeps every title within 60 and every description within 160 characters", () => {
    for (const key of keys) {
      expect(PAGES[key].title.length, `${key} title`).toBeLessThanOrEqual(60);
      expect(PAGES[key].description.length, `${key} description`).toBeLessThanOrEqual(160);
      expect(PAGES[key].description.length, `${key} description`).toBeGreaterThanOrEqual(50);
    }
  });

  it("has no duplicate titles or descriptions (one intent per page)", () => {
    const titles = keys.map((k) => PAGES[k].title);
    const descriptions = keys.map((k) => PAGES[k].description);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(descriptions).size).toBe(descriptions.length);
  });

  it("builds absolute self-canonicals and complete social tags", () => {
    const meta = pageMetadata("pricing");
    expect(meta.alternates?.canonical).toBe("https://noeystudio.com/pricing");
    expect(meta.openGraph).toMatchObject({ locale: "th_TH", siteName: "Noey Studio", url: "https://noeystudio.com/pricing" });
    expect(meta.twitter).toMatchObject({ card: "summary_large_image" });
  });

  it("gives every page a share image: its own file, or the site-wide default", () => {
    for (const key of keys) {
      const segment = PAGES[key].path === "/" ? "" : PAGES[key].path;
      const hasFile = existsSync(join(process.cwd(), "src", "app", ...segment.split("/").filter(Boolean), "opengraph-image.tsx"));
      expect(hasFile, `${key}: file vs PAGES_WITH_OWN_OG_IMAGE`).toBe(PAGES_WITH_OWN_OG_IMAGE.has(key));
      const og = pageMetadata(key).openGraph as { images?: unknown };
      // An explicit image would override the route's own generated image.
      expect(!!og.images, `${key}: explicit og images`).toBe(!hasFile);
    }
  });

  it("marks login noindex, legal pages follow the draft flag, marketing pages stay indexable", () => {
    expect(pageMetadata("login").robots).toMatchObject({ index: false });
    expect(pageMetadata("terms").robots).toMatchObject({ index: !LEGAL_PAGES_ARE_DRAFTS });
    expect(pageMetadata("privacy").robots).toMatchObject({ index: !LEGAL_PAGES_ARE_DRAFTS });
    expect(pageMetadata("scope").robots).toMatchObject({ index: true });
    expect(pageMetadata("home").robots).toMatchObject({ index: true });
    expect(pageMetadata("signup").robots).toMatchObject({ index: true });
  });
});

describe("JSON-LD builders", () => {
  it("prices SoftwareApplication offers from the same table the page renders", () => {
    const table = normalizePlansResponse({
      source: "stripe",
      currency: "thb",
      plans: [
        { tier: "lite", unit_amount: 19900 },
        { tier: "pro", unit_amount: 99000 },
      ],
    })!;
    const node = softwareApplicationNode(table);
    const offers = node.offers as Array<Record<string, unknown>>;
    expect(offers.map((o) => [o.name, o.price])).toEqual([
      [PLAN_COPY.free.name, "0"],
      ["Lite", "199"],
      ["Pro", "990"],
    ]);
    expect(offers.every((o) => o.priceCurrency === "THB")).toBe(true);
  });

  it("points the Organization logo at an icon the site actually generates", () => {
    const logo = organizationNode().logo as { url: string; width: number };
    const name = logo.url.replace("https://noeystudio.com/icons/", "");
    expect(logo.url).toBe(`https://noeystudio.com/icons/${name}`);
    expect(Object.keys(APP_ICONS)).toContain(name);
    expect(APP_ICONS[name as keyof typeof APP_ICONS].size).toBe(logo.width);
  });

  it("never emits ratings or reviews", () => {
    const json = serializeJsonLd(
      jsonLdGraph(organizationNode(), softwareApplicationNode(fallbackPriceTable()), faqPageNode(HOME_FAQ, "/")),
    );
    expect(json).not.toMatch(/AggregateRating|"Review"|ratingValue|reviewCount/);
  });

  it("uses the visible FAQ text verbatim", () => {
    const node = faqPageNode(PRICING_FAQ, "/pricing");
    const entities = node.mainEntity as Array<{ name: string; acceptedAnswer: { text: string } }>;
    expect(entities.map((e) => e.name)).toEqual(PRICING_FAQ.map((f) => f.question));
    expect(entities.map((e) => e.acceptedAnswer.text)).toEqual(PRICING_FAQ.map((f) => f.answer));
  });

  it("numbers breadcrumbs from 1 with absolute URLs", () => {
    const node = breadcrumbNode([
      { name: "หน้าแรก", path: "/" },
      { name: "ราคา", path: "/pricing" },
    ]);
    expect(node.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "หน้าแรก", item: "https://noeystudio.com" },
      { "@type": "ListItem", position: 2, name: "ราคา", item: "https://noeystudio.com/pricing" },
    ]);
  });

  it("escapes < so a value cannot close the script tag", () => {
    const html = serializeJsonLd(webPageNode({ path: "/", name: "</script><b>", description: "x", dateModified: "2026-09-21" }));
    expect(html).not.toContain("</script>");
    expect(html).toContain("\\u003c/script>");
  });
});

describe("machine-readable files", () => {
  const table = fallbackPriceTable();

  it("llms.txt has a heading, a summary, links and the pricing link", () => {
    const text = buildLlmsTxt(table);
    expect(text).toMatch(/^# Noey Studio\n/);
    expect(text).toMatch(/^> /m);
    expect(text).toContain("](https://noeystudio.com/pricing)");
    expect(text).toContain("](https://noeystudio.com/pricing.md)");
    expect(text.length).toBeGreaterThan(100);
  });

  it("pricing.md lists every plan with the table's prices and the update date", () => {
    const md = buildPricingMarkdown(table, "2026-09-21");
    for (const name of ["ฟรี", "Lite", "Starter", "Pro", "Studio", "Agency", "Max"]) expect(md).toContain(`## ${name}`);
    expect(md).toContain("6,990 บาท/เดือน");
    expect(md).toContain("- ปริมาณการใช้งาน: 5x (ปริมาณการใช้งาน 5 เท่าของ Lite)");
    expect(md).toContain("อัปเดตล่าสุด: 2026-09-21");
    expect(md).toContain("| ราคา (บาท/เดือน) | 0 | 199 | 399 | 990 | 1,990 | 3,990 | 6,990 |");
  });

  it("pricing.md follows a changed backend price", () => {
    const changed = normalizePlansResponse({ source: "stripe", currency: "thb", plans: [{ tier: "pro", unit_amount: 99000 }] })!;
    expect(buildPricingMarkdown(changed, "2026-09-21")).toContain("990 บาท/เดือน");
  });
});

/**
 * Hard rule: no AI vendor may be named in UI, metadata or llms.txt. Scan the
 * generated text files plus every UI source file. lib/crawl.ts is exempt — it
 * must name crawler user-agents (e.g. the one called "ClaudeBot") to allow them.
 */
describe("no AI vendor names in user-facing output", () => {
  const banned = /gemini|claude|openai|chatgpt|\bgpt-|elevenlabs|eleven labs|twelve ?labs|anthropic|\bscribe\b/i;

  it("is absent from llms.txt and pricing.md", () => {
    expect(buildLlmsTxt(fallbackPriceTable())).not.toMatch(banned);
    expect(buildPricingMarkdown(fallbackPriceTable(), "2026-09-21")).not.toMatch(banned);
  });

  it("is absent from UI source files", () => {
    const root = join(process.cwd(), "src");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(tsx?|css)$/.test(entry) && !/\.test\.ts$/.test(entry)) files.push(full);
      }
    };
    walk(root);
    const offenders = files
      .filter((file) => !file.endsWith(join("lib", "crawl.ts")))
      .filter((file) => banned.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("crawling rules", () => {
  it("allows search and AI crawlers but keeps private and token pages out, in every group", () => {
    const rules = robotsRules().rules as Array<{ userAgent: string | string[]; allow: string; disallow: string[] }>;
    const agents = rules.flatMap((rule) => (Array.isArray(rule.userAgent) ? rule.userAgent : [rule.userAgent]));
    for (const bot of ["*", "GPTBot", "OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "ClaudeBot", "Claude-SearchBot", "Google-Extended", "Bingbot"]) {
      expect(agents).toContain(bot);
    }
    for (const rule of rules) {
      expect(rule.allow).toBe("/");
      expect(rule.disallow).toEqual(expect.arrayContaining(["/account", "/checkout", "/api", "/reset-password", "/verify-email"]));
      expect(rule.disallow).not.toContain("/");
    }
    expect(robotsRules().sitemap).toBe("https://noeystudio.com/sitemap.xml");
  });

  it("marks emailed token pages noindex with no referrer", () => {
    const meta = tokenPageMetadata("ตั้งรหัสผ่านใหม่");
    expect(meta.robots).toMatchObject({ index: false, follow: false });
    expect(meta.referrer).toBe("no-referrer");
    expect(meta.alternates).toBeUndefined();
  });

  it("keeps token pages out of the page registry, hence out of the sitemap", () => {
    const paths = Object.values(PAGES).map((page) => page.path);
    expect(paths).not.toContain("/reset-password");
    expect(paths).not.toContain("/verify-email");
  });
});
