"use client";

import { useEffect, useRef } from "react";

export const OK = "#2f6b45";
export const LOSS = "#a33a34";

export const TASKS: Array<{ k: "stt" | "cut" | "fx" | "style" | "extra" | "other"; label: string; color: string }> = [
  { k: "stt", label: "ถอดเสียง", color: "#7d5411" },
  { k: "cut", label: "ตัดคลิป", color: "#b68235" },
  { k: "fx", label: "เอฟเฟกต์กล้อง", color: "#c28d41" },
  { k: "style", label: "สไตล์การตัด", color: "#e1ad66" },
  { k: "extra", label: "SMS และอีเมล", color: "#9b9797" },
  { k: "other", label: "อื่นๆ", color: "#bab6b6" },
];

export function Seg<T extends string>({
  options, value, onChange, label, style,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
  label: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className="seg" role="group" aria-label={label} style={style}>
      {options.map((o) => (
        <button key={o.value} type="button" className="seg-btn" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function TaskBars({ rows, size = "lg" }: { rows: Array<{ label: string; color: string; value: string; pct: string; w: number }>; size?: "lg" | "sm" }) {
  const sm = size === "sm";
  return (
    <>
      {rows.map((t) => (
        <div key={t.label} style={{ marginBottom: sm ? 11 : 14 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: sm ? 4 : 5, fontSize: sm ? 13 : undefined }}>
            <span style={{ fontSize: sm ? 13 : 13.5 }}>{t.label}</span>
            <span style={{ flex: 1 }} />
            <span className="num" style={{ fontSize: sm ? 13 : 12.5, color: "var(--color-neutral-600)" }}>{t.pct}</span>
            <span className="num" style={{ fontSize: sm ? 13 : 13.5, width: sm ? 78 : 88, textAlign: "right" }}>{t.value}</span>
          </div>
          <div className="bar-track" style={{ height: sm ? 6 : 7 }}>
            <div className="bar-fill" style={{ width: `${t.w}%`, background: t.color }} />
          </div>
        </div>
      ))}
    </>
  );
}

export function NumberInput({
  value, onChange, width, step, disabled, label, min = 0, style,
}: {
  value: number;
  onChange: (v: number) => void;
  width?: number;
  step?: number;
  disabled?: boolean;
  label: string;
  min?: number;
  style?: React.CSSProperties;
}) {
  return (
    <input
      className="input num"
      type="number"
      aria-label={label}
      value={Number.isFinite(value) ? value : 0}
      step={step}
      min={min}
      disabled={disabled}
      onChange={(e) => {
        const v = e.target.value === "" ? 0 : Number(e.target.value);
        if (Number.isFinite(v)) onChange(v);
      }}
      style={{ width, textAlign: "right", fontFamily: "inherit", minHeight: 32, ...style }}
    />
  );
}

export interface ConfirmSpec {
  title: string;
  body: string;
  lines: string[];
  okLabel: string;
  danger?: boolean;
  ok: () => Promise<void> | void;
}

export function ConfirmDialog({ spec, busy, onCancel, onOk }: { spec: ConfirmSpec; busy: boolean; onCancel: () => void; onOk: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);
  return (
    <>
      <div className="dialog-scrim" onClick={() => !busy && onCancel()} />
      <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" className="confirm">
        <div style={{ padding: "20px 22px 14px" }}>
          <p id="confirm-title" style={{ margin: 0, fontSize: 18, fontWeight: 500 }}>{spec.title}</p>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--color-neutral-700)", wordBreak: "break-all" }}>{spec.body}</p>
        </div>
        <div style={{ padding: "0 22px 4px", maxHeight: 280, overflowY: "auto" }}>
          {spec.lines.map((l, i) => (
            <div key={i} className="num" style={{ display: "flex", gap: 10, padding: "8px 0", borderTop: "1px solid var(--color-divider)", fontSize: 13 }}>
              <span style={{ color: "var(--color-neutral-500)" }}>·</span>
              <span>{l}</span>
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, padding: "16px 22px 20px" }}>
          <button ref={cancelRef} type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy} style={{ fontFamily: "inherit", fontSize: 13 }}>ยกเลิก</button>
          <button
            type="button"
            className="btn"
            onClick={onOk}
            disabled={busy}
            style={{ fontFamily: "inherit", fontSize: 13, ...(spec.danger ? { color: LOSS, borderColor: LOSS } : { color: "var(--color-accent)", borderColor: "var(--color-accent)" }) }}
          >
            {busy ? "กำลังบันทึก…" : spec.okLabel}
          </button>
        </div>
      </div>
    </>
  );
}
