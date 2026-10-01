import type { CSSProperties } from "react";
import { keepThaiProse } from "@/components/ds/ThaiProse";
import { formatTimecode, seeded } from "@/components/ds/timecode";
import { slugSeed } from "@/lib/blog";

/**
 * The cover a post gets when it has no picture: a slate (the clapperboard
 * held up at the start of every take) drawn from the post itself — the
 * clapper's stripes run on the logo's splice angle, the scene is the post's
 * category, the take is its title, and under it a track of clips cut on the
 * same diagonal with the playhead parked part-way. Shapes and words only; no
 * stock picture, nothing to download.
 *
 * Seeded by the slug, so a post keeps the same slate on every card and on
 * its own page. A dark monitor in both themes (theme-night), like the guide
 * index's thumbnails. Decorative (aria-hidden): the card and the page carry
 * the title as real text.
 */
export function Slate({
  slug,
  title,
  category,
  minutes,
  size = "card",
}: {
  slug: string;
  title: string;
  category: string;
  /** Unknown for a related post (the API does not send it): then no length is printed. */
  minutes?: number;
  size?: "card" | "hero" | "feature";
}) {
  const random = seeded(slugSeed(slug));
  // Three to five clips across the track, cut where the takes change.
  const count = 3 + Math.floor(random() * 3);
  const weights = Array.from({ length: count }, () => 0.6 + random());
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let left = 0;
  const clips = weights.map((weight, index) => {
    const width = (weight / total) * 100;
    const clip = { left, width, tone: index % 3 };
    left += width;
    return clip;
  });
  const head = 22 + random() * 52;
  const take = String(1 + Math.floor(random() * 9)).padStart(2, "0");
  return (
    <div className={`slate slate--${size} theme-night`} aria-hidden="true" style={{ "--slate-glow": `${15 + Math.round(random() * 60)}%` } as CSSProperties}>
      <span className="slate__glow" />
      <div className="slate__clapper">
        <span className="slate__stick" />
        <span className="slate__stick slate__stick--base" />
      </div>
      <div className="slate__body">
        <div className="slate__row">
          <span className="slate__field">
            <span className="tc slate__key">SCENE</span>
            <span className="slate__scene">{category}</span>
          </span>
          <span className="slate__field slate__field--end">
            <span className="tc slate__key">TAKE</span>
            <span className="tc slate__take">{take}</span>
          </span>
        </div>
        <p className="slate__title">{keepThaiProse(title)}</p>
        <div className="slate__track">
          <span className="slate__timeline">
            <span className="slate__ruler" />
            <span className="slate__lane">
              {clips.map((clip, index) => (
                <i
                  key={index}
                  className={`slate__clip slate__clip--${clip.tone}`}
                  style={{ left: `${clip.left.toFixed(2)}%`, width: `${clip.width.toFixed(2)}%` }}
                />
              ))}
            </span>
            <span className="slate__head" style={{ left: `${head.toFixed(2)}%` }} />
          </span>
          {minutes ? <span className="tc slate__tc">{formatTimecode(minutes * 60)}</span> : null}
        </div>
      </div>
    </div>
  );
}
