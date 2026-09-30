import { createElement, type CSSProperties, type ReactNode } from "react";
import { tilePosition } from "../sample";
import { APP_ICONS, type AppIconName } from "./icons";

/**
 * The editor's UI primitives (web/src/components/ui), redrawn for the mock-ups:
 * the same elements and Tailwind classes, minus behaviour. Controls are
 * spans, not buttons — a mock-up is a picture, never focusable. Hover, focus
 * and active variants are left out for the same reason; a disabled control
 * spells out its disabled classes instead of relying on :disabled.
 */

export const cn = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");

/**
 * A part of the app the drawing leaves out (owner, 2026-10-01: draw what makes
 * the picture, and whatever is drawn sits where the app puts it). It keeps its
 * place in the layout, so everything drawn stays in position, but it is not
 * painted (mock.css).
 */
export function Omit({ children }: { children: ReactNode }) {
  return <span className="am-omit">{children}</span>;
}

/** A Lucide icon, as lucide-react renders it. */
export function Icon({
  name,
  size = 24,
  strokeWidth = 2,
  className,
  fill = "none",
}: {
  name: AppIconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  fill?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {APP_ICONS[name].map(([tag, attrs], index) => createElement(tag, { key: index, ...attrs }))}
    </svg>
  );
}

/** ui/BrandMark.tsx — the N with the splice. */
export function BrandMark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={size < 28 ? 15 : 13} strokeLinecap="round" className={className} aria-hidden="true">
      <path d="M22 78 V 22" />
      <path d="M22 22 L 44 55" />
      <path d="M56 45 L 78 78" />
      <path d="M78 78 V 22" />
    </svg>
  );
}

/** A spinning Loader2, as the app's `animate-spin` draws it. */
export function Spinner({ size, className }: { size: number; className?: string }) {
  return <Icon name="Loader2" size={size} className={cn("am-spin", className)} />;
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANT: Record<Variant, string> = {
  primary: "border border-accent bg-accent-tint text-accent",
  secondary: "border border-border text-ink",
  ghost: "text-muted",
  danger: "border border-error bg-error-tint text-error",
};

const DISABLED: Record<Variant, string> = {
  primary: "border border-[rgb(217_164_65_/_0.4)] bg-[rgb(217_164_65_/_0.06)] text-[rgb(217_164_65_/_0.55)]",
  secondary: "border border-border-faint text-[rgb(243_242_242_/_0.4)]",
  ghost: "text-[rgb(243_242_242_/_0.4)]",
  danger: "border border-[rgb(224_139_132_/_0.4)] bg-error-tint text-[rgb(224_139_132_/_0.55)]",
};

/** ui/Button.tsx: 40px (36 small), icon before the label, a reason beside a disabled one. */
export function Button({
  variant = "secondary",
  size = "md",
  icon,
  iconOnly = false,
  disabled = false,
  reason,
  className,
  children,
  ...data
}: {
  variant?: Variant;
  size?: "md" | "sm";
  icon?: ReactNode;
  iconOnly?: boolean;
  disabled?: boolean;
  /** A disabled button's reason, printed beside it (reasonAs="text"). */
  reason?: ReactNode;
  className?: string;
  children?: ReactNode;
} & { [key: `data-${string}`]: string | undefined }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={cn(
          "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-semibold",
          size === "sm" ? "h-9 text-sm" : "h-10 text-[15px]",
          iconOnly ? "min-w-11 px-0" : variant === "primary" ? "px-5" : "px-4",
          disabled ? DISABLED[variant] : VARIANT[variant],
          className,
        )}
        {...data}
      >
        {icon}
        {!iconOnly && children}
      </span>
      {disabled && reason ? <span className="text-xs text-muted">{reason}</span> : null}
    </span>
  );
}

/** ui/Segmented.tsx — one rail of options, the selected one gold. */
export function Segmented({
  options,
  value,
  numeric = false,
  className,
  optionData,
}: {
  options: ReadonlyArray<{ value: string; label: ReactNode }>;
  value: string | null;
  numeric?: boolean;
  className?: string;
  /** data-* attributes per option value (the choreography's targets). */
  optionData?: Record<string, Record<string, string>>;
}) {
  return (
    <span className={cn("inline-flex min-h-[34px] max-w-full flex-wrap items-center rounded-md border border-border-faint", className)}>
      {options.map((option, index) => (
        <span key={option.value} className="contents">
          {index > 0 ? <span className="h-[34px] w-px bg-divider" /> : null}
          <span
            className={cn(
              "flex h-[34px] items-center gap-2 whitespace-nowrap px-3.5 text-sm",
              index === 0 && "rounded-l-[5px]",
              index === options.length - 1 && "rounded-r-[5px]",
              numeric && option.value !== "custom" && "tabular-nums",
              option.value === value ? "bg-accent-tint font-semibold text-accent" : "text-ink-2",
            )}
            {...optionData?.[option.value]}
          >
            {option.label}
          </span>
        </span>
      ))}
    </span>
  );
}

/** ui/Tabs.tsx — underline tabs. */
export function Tabs({ items, active, className }: { items: readonly string[]; active: string; className?: string }) {
  return (
    <div className={cn("flex gap-5 overflow-x-auto border-b border-divider", className)}>
      {items.map((item) => (
        <span
          key={item}
          className={cn(
            "flex h-[34px] shrink-0 items-center whitespace-nowrap text-sm",
            item === active ? "font-semibold text-accent shadow-[inset_0_-2px_0_var(--color-accent)]" : "text-muted",
          )}
        >
          {item}
        </span>
      ))}
    </div>
  );
}

/**
 * ui/Input.tsx Textarea, with its text drawn in: rows × 22.5px lines plus
 * padding and border. Inline-block with hidden overflow inside a block, like
 * the real field — its line box leaves the same gap under it.
 */
export function TextareaBox({ rows, value, placeholder, className }: { rows: number; value?: ReactNode; placeholder?: string; className?: string }) {
  return (
    <div>
      <span
        className={cn("inline-block min-h-16 w-full overflow-hidden rounded-md border border-border bg-transparent px-3 py-2.5 text-[15px] leading-[1.5] text-ink", className)}
        style={{ height: rows * 22.5 + 22 }}
      >
        {value ? value : <span className="text-[rgb(243_242_242_/_0.5)]">{placeholder}</span>}
      </span>
    </div>
  );
}

/** ui/Input.tsx Input (size lg), inline-block like the real field. */
export function InputBox({ value, className }: { value: string; className?: string }) {
  return (
    <div>
      <span className={cn("inline-flex h-11 w-full items-center overflow-hidden rounded-md border border-border bg-transparent px-3 text-[16px] text-ink", className)}>{value}</span>
    </div>
  );
}

/**
 * The inside of a <button> that holds inline text (a lane block, a chip):
 * the button centres its content box vertically, and the text stays an
 * inline run in it. `inline` for a button in normal flow — it is
 * inline-block, so it sits on its parent's baseline like the real one.
 */
export function ButtonBody({ inline = false, className, children }: { inline?: boolean; className?: string; children: ReactNode }) {
  return (
    <span className={cn(inline ? "inline-flex" : "flex", "flex-col justify-center", className)}>
      <span className="block">{children}</span>
    </span>
  );
}

/** ui/ChoiceMenu.tsx, closed: the 38px trigger. */
export function ChoiceTrigger({ label }: { label: string }) {
  return (
    <div className="relative w-full max-w-[300px]">
      <span className="flex h-[38px] w-full items-center gap-2.5 rounded-md border border-border bg-transparent px-3 text-left text-sm text-ink">
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <Icon name="ChevronDown" size={15} className="shrink-0 text-muted" />
      </span>
    </div>
  );
}

/** ui/Checkbox.tsx indicator. */
export function CheckboxMark({ checked }: { checked: boolean }) {
  return (
    <span
      className={cn(
        "relative flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[3px] border",
        checked ? "border-accent bg-[rgb(217_164_65_/_0.16)]" : "border-[rgb(243_242_242_/_0.4)] bg-transparent",
      )}
    >
      {checked ? <Icon name="Check" size={12} strokeWidth={3} className="text-accent" /> : null}
    </span>
  );
}

/** ui/Switch.tsx, with its label. */
export function SwitchMark({ on, label }: { on: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span
        className={cn(
          "relative flex h-5 w-9 shrink-0 items-center rounded-full border p-[3px]",
          on ? "border-accent bg-[rgb(217_164_65_/_0.25)]" : "border-border bg-transparent",
        )}
      >
        <span className={cn("h-3.5 w-3.5 rounded-full", on ? "translate-x-[14px] bg-accent" : "translate-x-0 bg-[rgb(243_242_242_/_0.5)]")} />
      </span>
      <span className="text-sm text-ink">{label}</span>
    </span>
  );
}

/**
 * A frame of the sample footage at a thumbnail's size: one tile of
 * /footage/strip.webp, scaled to the box's width and centred (the editor
 * cover-fits its 54×96 tiles the same way). The strip is attached by the
 * mock-up's root once it is near the screen (`--am-strip`).
 */
export function Tile({ index, className, style }: { index: number; className?: string; style?: CSSProperties }) {
  return <span className={cn("am-tile", className)} style={{ backgroundPosition: tilePosition(index), ...style }} />;
}

/** A scene still: a <picture> with AVIF and WebP, lazy — never part of the first paint. */
export function Still({ src, className }: { src: { avif: string; webp: string }; className?: string }) {
  return (
    <picture className="contents">
      <source type="image/avif" srcSet={src.avif} />
      <img src={src.webp} alt="" loading="lazy" decoding="async" width={720} height={1280} className={className} />
    </picture>
  );
}

/** shell/TitleBar.tsx and OverlayTitleBarSpacer.tsx: the 38px strip every screen starts with. */
export function TitleBar({ label, note }: { label: string; note?: string }) {
  return (
    <div className="flex h-[38px] shrink-0 items-center justify-between border-b border-divider bg-surface px-3.5">
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <BrandMark size={14} className="shrink-0 text-accent" />
        <span className="truncate text-[13px] text-muted">{label}</span>
      </span>
      {note ? <span className="shrink-0 pl-4 text-[13px] text-muted">{note}</span> : null}
    </div>
  );
}
