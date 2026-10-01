import "server-only";
import { imageSize, type ImageSize } from "../image-size";

/**
 * The size of an image in a blog post's Markdown (Markdown carries none).
 * The media store's files are content-addressed and never change, so a size
 * is read once per URL: from the data cache (a month) and this process's
 * memory. A failure is not fatal — the image is then drawn without a size.
 */

const MAX_BYTES = 12 * 1024 * 1024;
const known = new Map<string, ImageSize | null>();

export async function blogImageSize(url: string): Promise<ImageSize | null> {
  if (known.has(url)) return known.get(url) ?? null;
  let size: ImageSize | null = null;
  try {
    const response = await fetch(url, {
      headers: { Accept: "image/webp,image/png,image/jpeg,image/gif" },
      cache: "force-cache",
      next: { revalidate: 60 * 60 * 24 * 30, tags: ["blog-media"] },
      signal: AbortSignal.timeout(5_000),
    });
    const length = Number(response.headers.get("content-length") ?? 0);
    if (response.ok && length <= MAX_BYTES) size = imageSize(new Uint8Array(await response.arrayBuffer()));
  } catch {
    size = null;
  }
  if (known.size > 500) known.clear();
  // Only a size is remembered: a failure is retried on the next render.
  if (size) known.set(url, size);
  return size;
}
