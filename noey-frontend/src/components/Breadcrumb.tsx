import Link from "next/link";
import type { Crumb } from "@/lib/jsonld";

/**
 * The design's small uppercase eyebrow above each inner page's H1, rendered
 * as a real breadcrumb ("หน้าแรก › ราคา") so the BreadcrumbList JSON-LD
 * describes something visitors actually see, and adds a link home.
 */
export function Breadcrumb({ trail }: { trail: readonly Crumb[] }) {
  return (
    <nav aria-label="เส้นทางนำทาง" className="eyebrow">
      {trail.map((crumb, index) => {
        const last = index === trail.length - 1;
        return (
          <span key={crumb.path}>
            {last ? (
              <span aria-current="page">{crumb.name}</span>
            ) : (
              <>
                <Link href={crumb.path}>{crumb.name}</Link>
                <span className="crumb-sep" aria-hidden="true">
                  ›
                </span>
              </>
            )}
          </span>
        );
      })}
    </nav>
  );
}
