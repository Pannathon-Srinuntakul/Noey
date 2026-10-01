import { LoadingFrame, RenderLoading, Skel, SkelLines } from "./RenderLoading";
import "../../styles/pages/article.css";

const TOC_WIDTHS = ["11em", "14em", "9em", "12em", "8em", "4em"] as const;

/**
 * A guide article (and any article page to come): the hero's breadcrumb,
 * title, answer and meta line, the centre piece where the picture goes, the
 * timeline table of contents, and the first sections' headings and
 * paragraphs.
 */
export function ArticleSkeletonBody({ demo = false }: { demo?: boolean }) {
  return (
    <>
      <header className={demo ? "phero phero--split" : "phero page-top phero--split"}>
        <div className="phero__backdrop" aria-hidden="true">
          <span className="phero__beam" />
          <span className="phero__ruler" />
        </div>
        <div className="wrap phero__inner">
          <div className="phero__copy" aria-hidden="true">
            <div className="phero__crumb">
              <Skel w="13em" />
            </div>
            <div className="h-1 article-skel__title">
              <SkelLines widths={["96%", "62%"]} />
            </div>
            <div className="phero__lead">
              <div className="answer">
                <SkelLines widths={["100%", "100%", "94%", "48%"]} />
              </div>
            </div>
            <div className="phero__meta">
              <p className="stamp">
                <Skel w="17em" />
              </p>
            </div>
          </div>
          <div className="phero__aside article-skel__aside">
            <RenderLoading />
          </div>
        </div>
      </header>
      <div className="wrap article-layout" aria-hidden="true">
        <aside className="article-layout__toc">
          <div className="toc">
            <div className="toc__mobile">
              <div className="article-skel__toc-bar">
                <Skel w="7em" />
              </div>
            </div>
            <div className="toc__desk">
              <p className="toc__label">
                <Skel w="7em" />
              </p>
              <div className="toc__rail">
                <span className="toc__line" />
                <ol className="toc__list">
                  {TOC_WIDTHS.map((width, index) => (
                    <li key={index}>
                      <span className="toc__link">
                        <span className="toc__n tc">{String(index + 1).padStart(2, "0")}</span>
                        <span className="toc__text">
                          <Skel w={width} />
                        </span>
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>
        </aside>
        <div className="article">
          {[0, 1].map((section) => (
            <section key={section} className="article__section">
              <div className="article__cue">
                <span className="trk tc">{String(section + 1).padStart(2, "0")}</span>
              </div>
              <div className="article__h2">
                <Skel w={section ? "11em" : "13em"} />
              </div>
              <div className="prose">
                <p>
                  <SkelLines widths={["100%", "98%", "100%", "72%"]} />
                </p>
                <p>
                  <SkelLines widths={["100%", "94%", "56%"]} />
                </p>
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

/** The route loading state of an article page. */
export function ArticleSkeleton() {
  return (
    <main id="main" className="article-page">
      <LoadingFrame>
        <ArticleSkeletonBody />
      </LoadingFrame>
    </main>
  );
}
