/**
 * JSON-LD builders. Every node describes content that is visible on the page
 * that emits it (schema must match on-page content). Deliberately absent:
 * AggregateRating / Review (no real ratings exist — never fabricate them) and
 * WebSite SearchAction (the site has no search).
 */
import type { FaqItem } from "./faq";
import { appIconPath } from "./icons";
import { PAID_TIERS, PLAN_COPY, schemaPrice, type PriceTable } from "./plans";
import { LANG, SITE_NAME, SITE_URL, absoluteUrl } from "./site";

export type JsonLdNode = Record<string, unknown>;

export const ORGANIZATION_ID = `${SITE_URL}/#organization`;
export const WEBSITE_ID = `${SITE_URL}/#website`;
export const SOFTWARE_ID = `${SITE_URL}/#software`;

/** Wording matches the footer's product description. */
export const SOFTWARE_DESCRIPTION =
  "ห้องตัดต่อวิดีโอด้วย AI ที่เปิดในเบราว์เซอร์ ถอดเสียงไทย ตัดคลิปอัตโนมัติ พากย์เสียง และใส่ซับไทย";

export function organizationNode(options: { email?: string } = {}): JsonLdNode {
  const node: JsonLdNode = {
    "@type": "Organization",
    "@id": ORGANIZATION_ID,
    name: SITE_NAME,
    url: absoluteUrl("/"),
    logo: {
      "@type": "ImageObject",
      url: absoluteUrl(appIconPath("icon-512.png")),
      width: 512,
      height: 512,
    },
  };
  if (options.email) {
    node.email = options.email;
    node.contactPoint = {
      "@type": "ContactPoint",
      contactType: "customer support",
      email: options.email,
      availableLanguage: ["th"],
    };
  }
  return node;
}

export function websiteNode(): JsonLdNode {
  return {
    "@type": "WebSite",
    "@id": WEBSITE_ID,
    name: SITE_NAME,
    url: absoluteUrl("/"),
    inLanguage: LANG,
    publisher: { "@id": ORGANIZATION_ID },
  };
}

/**
 * The product with one Offer per plan, priced from the SAME table the page
 * renders. A paid tier the backend did not list is left out instead of being
 * given an invented price.
 */
export function softwareApplicationNode(table: PriceTable): JsonLdNode {
  const pricingUrl = absoluteUrl("/pricing");
  const offers: JsonLdNode[] = [
    {
      "@type": "Offer",
      name: PLAN_COPY.free.name,
      price: "0",
      priceCurrency: "THB",
      url: pricingUrl,
    },
  ];
  for (const tier of PAID_TIERS) {
    const price = table.prices[tier];
    if (!price) continue;
    const amount = schemaPrice(price.amountSatang);
    offers.push({
      "@type": "Offer",
      name: PLAN_COPY[tier].name,
      price: amount,
      priceCurrency: "THB",
      url: pricingUrl,
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: amount,
        priceCurrency: "THB",
        unitText: "เดือน",
        referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitCode: "MON" },
      },
    });
  }
  return {
    "@type": "SoftwareApplication",
    "@id": SOFTWARE_ID,
    name: SITE_NAME,
    applicationCategory: "MultimediaApplication",
    operatingSystem: "Web browser (Chrome, Edge)",
    inLanguage: LANG,
    url: absoluteUrl("/"),
    description: SOFTWARE_DESCRIPTION,
    publisher: { "@id": ORGANIZATION_ID },
    offers,
  };
}

export function faqPageNode(items: readonly FaqItem[], path: string): JsonLdNode {
  return {
    "@type": "FAQPage",
    "@id": `${absoluteUrl(path)}#faq`,
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.question,
      acceptedAnswer: { "@type": "Answer", text: item.answer },
    })),
  };
}

export interface Crumb {
  name: string;
  path: string;
}

export function breadcrumbNode(trail: readonly Crumb[]): JsonLdNode {
  return {
    "@type": "BreadcrumbList",
    itemListElement: trail.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: absoluteUrl(crumb.path),
    })),
  };
}

export interface WebPageInput {
  path: string;
  name: string;
  description: string;
  /** ISO date the content last changed (from the page registry). */
  dateModified: string;
  type?: "WebPage" | "AboutPage" | "ContactPage" | "CollectionPage";
  /** @id of the entity this page is mainly about, e.g. the SoftwareApplication. */
  about?: string;
}

export function webPageNode(input: WebPageInput): JsonLdNode {
  const url = absoluteUrl(input.path);
  const node: JsonLdNode = {
    "@type": input.type ?? "WebPage",
    "@id": `${url}#webpage`,
    url,
    name: input.name,
    description: input.description,
    inLanguage: LANG,
    isPartOf: { "@id": WEBSITE_ID },
    dateModified: input.dateModified,
  };
  if (input.about) node.about = { "@id": input.about };
  return node;
}

export function jsonLdGraph(...nodes: JsonLdNode[]): JsonLdNode {
  return { "@context": "https://schema.org", "@graph": nodes };
}

/**
 * JSON for a <script> tag. `<` is escaped so a string containing
 * `</script>` cannot close the tag early (Next.js JSON-LD guide).
 */
export function serializeJsonLd(data: JsonLdNode): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
