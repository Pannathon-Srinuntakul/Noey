import type { CSSProperties } from "react";
import { IconArrowRight, IconMusic } from "../ds/icons";
import { splitWords } from "./sample";
import "../../styles/mockup.css";

/**
 * Tiny looping demos for the six feature cards: each shows its own feature
 * working (subtitles by word, the music switch, a trimmed clip, a swapped
 * take, a converted file, the 1080×1920 frame). Decorative; they only run
 * while on screen and never with reduced motion.
 */
export type MicroKind = "subs" | "music" | "trim" | "swap" | "convert" | "frame";

export function MicroDemo({ kind }: { kind: MicroKind }) {
  switch (kind) {
    case "subs":
      return (
        <span className="micro micro--subs">
          {splitWords("ซับขึ้นตามเสียงพูด")
            .filter((part) => part.word)
            .map((part, index) => (
              <span key={index} style={{ "--i": index } as CSSProperties}>
                {part.text}
              </span>
            ))}
        </span>
      );
    case "music":
      return (
        <span className="micro">
          <IconMusic size={15} />
          <span className="micro__toggle" />
          <span className="micro__eq">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <i key={index} style={{ "--i": index } as CSSProperties} />
            ))}
          </span>
        </span>
      );
    case "trim":
      return (
        <span className="micro micro--trim">
          <span className="micro__block" style={{ width: "30%" }} />
          <span className="micro__block micro__block--b" />
        </span>
      );
    case "swap":
      return (
        <span className="micro micro--swap">
          <span className="micro__slot">
            <span className="micro__take micro__take--1">TAKE 1</span>
            <span className="micro__take micro__take--2">TAKE 2</span>
          </span>
        </span>
      );
    case "convert":
      return (
        <span className="micro micro--convert">
          <span className="micro__chip">ฟอร์แมตแปลก</span>
          <span className="micro__progress" />
          <IconArrowRight size={14} />
          <span className="micro__chip micro__chip--out">MP4</span>
        </span>
      );
    case "frame":
      return (
        <span className="micro micro--frame">
          <span className="micro__phone" />
          <span className="micro__dims">1080 × 1920</span>
        </span>
      );
  }
}
