import { describe, expect, it } from "vitest";
import sitemap from "../app/sitemap";
import { CHANGELOG, CHANGELOG_UPDATED } from "./changelog";
import { buildChangelogFeed } from "./changelog-feed";
import { feedEntryKeys } from "./feed";
import { PAGES, absoluteUrl } from "./site";

const VENDORS = /Gemini|Claude|OpenAI|GPT|ElevenLabs|Twelve ?Labs|Anthropic|Google AI|Vertex/i;

describe("changelog", () => {
  it("dates the page by its newest entry", () => {
    expect(PAGES.changelog.updated).toBe(CHANGELOG_UPDATED);
  });

  it("lists entries newest first, each with a unique anchor", () => {
    const dates = CHANGELOG.map((entry) => entry.date);
    expect([...dates].sort().reverse()).toEqual(dates);
    const ids = CHANGELOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it("never names an AI vendor", () => {
    for (const entry of CHANGELOG) {
      const text = [entry.title, ...entry.body, entry.plans ?? "", entry.link?.label ?? ""].join(" ");
      expect(text, entry.id).not.toMatch(VENDORS);
    }
  });

  it("is in the sitemap and the site feed", async () => {
    expect((await sitemap()).map((item) => item.url)).toContain(absoluteUrl("/changelog"));
    expect(feedEntryKeys()).toContain("changelog");
  });

  it("has its own Atom feed with one entry per change", () => {
    const xml = buildChangelogFeed();
    expect(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>')).toBe(true);
    expect(xml.match(/<entry>/g)?.length).toBe(CHANGELOG.length);
    expect(xml).toContain(`${absoluteUrl("/changelog")}#${CHANGELOG[0].id}`);
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
  });
});
