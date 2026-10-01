import { clipTile } from "../sample";
import { Tile } from "./ui";

/** The demo pointer, drawn in window pixels; its path is in hero.css. */
export function Pointer({ name, drag = false }: { name: string; drag?: boolean }) {
  return (
    <span className={`am-pointer am-pointer--${name}`} aria-hidden="true">
      {drag ? (
        <span className="am-pointer__ghost">
          <Tile index={clipTile(1)} className="am-pointer__file" />
          <Tile index={clipTile(0)} className="am-pointer__file" />
        </span>
      ) : null}
      <svg viewBox="0 0 24 24" className="am-pointer__arrow">
        <path d="M5 3l14 8-6.2 1.6L10 19 5 3Z" fill="#fff" stroke="#111" strokeWidth="1.3" strokeLinejoin="round" />
      </svg>
      <span className="am-pointer__press" />
    </span>
  );
}

