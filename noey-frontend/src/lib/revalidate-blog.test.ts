import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ revalidateTag: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("next/cache", () => cache);
const gate = vi.hoisted(() => ({ forgetBlogIndex: vi.fn() }));
vi.mock("@/lib/blog-proxy", () => gate);

import { NextRequest } from "next/server";
import { POST } from "@/app/api/revalidate-blog/route";

const SECRET = "s3cret-for-tests-0123456789";

function request(body: unknown, auth: string | null = `Bearer ${SECRET}`) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth !== null) headers.authorization = auth;
  return new NextRequest("http://127.0.0.1/api/revalidate-blog", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/revalidate-blog", () => {
  beforeEach(() => vi.stubEnv("BLOG_REVALIDATE_SECRET", SECRET));
  afterEach(() => {
    vi.unstubAllEnvs();
    cache.revalidateTag.mockReset();
    cache.revalidatePath.mockReset();
    gate.forgetBlogIndex.mockReset();
  });

  it("does not exist (404) when no secret is configured", async () => {
    vi.stubEnv("BLOG_REVALIDATE_SECRET", "");
    expect((await POST(request({ slugs: ["a"] }))).status).toBe(404);
    expect(cache.revalidateTag).not.toHaveBeenCalled();
  });

  it("refuses a missing or wrong secret (401) and revalidates nothing", async () => {
    for (const auth of [null, "", "Bearer", "Bearer wrong", `Basic ${SECRET}`, SECRET, `Bearer ${SECRET}x`]) {
      expect((await POST(request({ slugs: ["a"] }, auth))).status, String(auth)).toBe(401);
    }
    expect(cache.revalidateTag).not.toHaveBeenCalled();
    expect(cache.revalidatePath).not.toHaveBeenCalled();
    expect(gate.forgetBlogIndex).not.toHaveBeenCalled();
  });

  it("refuses odd slugs, more than 20 of them, and a body that is not JSON (400)", async () => {
    for (const body of [{ slugs: ["../../etc"] }, { slugs: ["Thai-Subtitles"] }, { slugs: ["a b"] }, { slugs: "a" }, {}, [], { slugs: Array.from({ length: 21 }, (_, i) => `p-${i}`) }]) {
      expect((await POST(request(body))).status, JSON.stringify(body)).toBe(400);
    }
    expect((await POST(request("not json"))).status).toBe(400);
    expect((await POST(request({ slugs: ["a".repeat(80)], pad: "x".repeat(9000) }))).status).toBe(413);
    expect(cache.revalidateTag).not.toHaveBeenCalled();
  });

  it("expires the blog's data and every page that lists or shows the posts", async () => {
    const response = await POST(request({ slugs: ["thai-subtitles-tiktok-tips"] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revalidated: true, slugs: ["thai-subtitles-tiktok-tips"] });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(cache.revalidateTag).toHaveBeenCalledWith("blog", { expire: 0 });
    expect(cache.revalidateTag).toHaveBeenCalledWith("blog:thai-subtitles-tiktok-tips", { expire: 0 });
    const paths = cache.revalidatePath.mock.calls.map((call) => call.join(" "));
    for (const path of [
      "/blog/thai-subtitles-tiktok-tips",
      "/blog/md/thai-subtitles-tiktok-tips",
      "/blog",
      "/blog/page/[page] page",
      "/blog/category/[slug]/page/[page] page",
      "/blog/tag/[slug]/page/[page] page",
      "/sitemap.xml",
      "/feed.xml",
      "/blog/feed.xml",
      "/llms.txt",
    ]) {
      expect(paths, path).toContain(path);
    }
  });

  it("drops Proxy's index of published posts, so a post just published or taken down is judged afresh", async () => {
    expect((await POST(request({ slugs: ["a-post"] }))).status).toBe(200);
    expect(gate.forgetBlogIndex).toHaveBeenCalledTimes(1);
  });
});
