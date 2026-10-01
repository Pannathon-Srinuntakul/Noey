import type { CSSProperties } from "react";
import { seeded } from "@/components/ds/timecode";
import { slugSeed } from "@/lib/blog";

/**
 * The cover a post gets when it has no picture (or its picture fails): a
 * slate, the clapperboard held up at the start of every take. Its sticks
 * are chalk-light stripes on the dark board, on the logo's splice angle;
 * only the hinge is gold — and the whole arm when the card is picked up and
 * the slate claps shut. On the board: the production, the scene (the post's
 * category) and the take, then a track of clips cut on the same diagonal
 * with the playhead parked part-way.
 *
 * It never repeats the title or the reading time: the card and the page
 * print those as text. Seeded by the slug, so a post keeps the same slate
 * everywhere; a dark board in both themes (theme-night). Decorative
 * (aria-hidden). No hooks: a client component can draw it too (CoverImage,
 * when a picture fails).
 */
export function Slate({ slug, category, size = "card" }: { slug: string; category: string; size?: "card" | "hero" | "feature" }) {
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
  const roll = `A${1 + Math.floor(random() * 4)}`;
  return (
    <div className={`slate slate--${size} theme-night`} aria-hidden="true" style={{ "--slate-glow": `${15 + Math.round(random() * 60)}%` } as CSSProperties}>
      <span className="slate__glow" />
      <div className="slate__clapper">
        <span className="slate__stick slate__stick--arm" />
        <span className="slate__stick slate__stick--base" />
        <span className="slate__hinge" />
      </div>
      <div className="slate__body">
        <div className="slate__row">
          <span className="tc slate__key">PROD.</span>
          <span className="tc slate__prod">NOEY STUDIO</span>
          <span className="tc slate__key slate__roll">ROLL {roll}</span>
        </div>
        <div className="slate__fields">
          <span className="slate__field slate__field--scene">
            <span className="tc slate__key">SCENE</span>
            <span className="slate__scene">{category}</span>
          </span>
          <span className="slate__field slate__field--take">
            <span className="tc slate__key">TAKE</span>
            <span className="tc slate__take">{take}</span>
          </span>
        </div>
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
      </div>
    </div>
  );
}
