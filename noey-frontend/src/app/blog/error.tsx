"use client";

import { usePathname } from "next/navigation";
import { BlogUnavailable } from "@/components/blog/BlogUnavailable";
import { BLOG_COPY } from "@/lib/blog";
import "../../styles/pages/blog.css";

/**
 * Every /blog page when the blog API is down AND there is no earlier copy
 * of the page to serve (ISR serves that copy whenever it has one). A calm
 * status card with a retry — a plain link, so it also works without
 * JavaScript; with JavaScript it re-renders the segment in place.
 */
export default function BlogError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const pathname = usePathname();
  return (
    <main id="main" className="blog-page blog-page--down">
      <div className="wrap page-top blog-down-page">
        <BlogUnavailable
          titleAs="h1"
          retry={
            <a
              href={pathname || "/blog"}
              className="btn btn-primary"
              onClick={(event) => {
                event.preventDefault();
                retry();
              }}
            >
              {BLOG_COPY.retry}
            </a>
          }
        />
      </div>
    </main>
  );
}
