import Link from "next/link";
import type { Crumb } from "@/lib/jsonld";

/**
 * The trail above each inner page's H1 ("หน้าแรก / ราคา"), a real breadcrumb
 * so the BreadcrumbList JSON-LD describes something visitors actually see.
 * The separator is the splice from the logo.
 */
export function Breadcrumb({ trail }: { trail: readonly Crumb[] }) {
  return (
    <nav aria-label="เส้นทางนำทาง" className="crumbs">
      <ol>
        {trail.map((crumb, index) => {
          const last = index === trail.length - 1;
          return (
            <li key={crumb.path}>
              {last ? (
                <span aria-current="page">{crumb.name}</span>
              ) : (
                <>
                  <Link href={crumb.path}>{crumb.name}</Link>
                  <svg className="crumbs__sep" viewBox="0 0 12 16" width="12" height="16" aria-hidden="true" focusable="false">
                    <path d="M2.5 13.5 5.5 9M6.5 7l3-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
                  </svg>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
