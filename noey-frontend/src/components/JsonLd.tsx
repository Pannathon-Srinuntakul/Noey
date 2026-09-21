import { serializeJsonLd, type JsonLdNode } from "@/lib/jsonld";

/** Server-rendered structured data (a plain <script>, per the Next.js JSON-LD guide). */
export function JsonLd({ data }: { data: JsonLdNode }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }} />;
}
