import { isUnderMediaBase } from "@/lib/blog";
import { blogMediaBase } from "@/lib/blog-media";

/**
 * Whether next/image may optimise `url`: only an https URL under the
 * configured media base — exactly what `images.remotePatterns` allows
 * (next.config.ts). Anything else is drawn as it is (`unoptimized`).
 */
export function isOptimizable(url: string): boolean {
  const base = blogMediaBase();
  if (!base || !base.startsWith("https:")) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && isUnderMediaBase(parsed, base);
  } catch {
    return false;
  }
}
