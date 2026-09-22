import { PAGES, absoluteUrl, type PageKey } from "./site";

/**
 * Response for a `.md` twin. Crawlable for agents, but the HTML page is the
 * canonical document — same contract as /pricing.md.
 */
export function markdownResponse(body: string, key: PageKey): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      Link: `<${absoluteUrl(PAGES[key].path)}>; rel="canonical"`,
    },
  });
}
