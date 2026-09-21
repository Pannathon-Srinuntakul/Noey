import type { MetadataRoute } from "next";
import { robotsRules } from "@/lib/crawl";

// Rules live in lib/crawl.ts (unit-tested).
export default function robots(): MetadataRoute.Robots {
  return robotsRules();
}
