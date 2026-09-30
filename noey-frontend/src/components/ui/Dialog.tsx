"use client";

import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";

/**
 * In-app modal styled like the design's `.dialog` (never window.confirm /
 * alert / prompt). Built on the native <dialog> element with showModal():
 * focus is moved in and trapped, Escape closes it, the page behind is inert,
 * and it sits in the top layer above the sticky header.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  maxWidth = 520,
  className,
  titleExtra,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  /** Width cap, published as a CSS variable so a variant can override it. */
  maxWidth?: number;
  /** Extra class on the <dialog> itself (e.g. the phone-width bottom sheet). */
  className?: string;
  /** Rendered next to the title, for a badge. */
  titleExtra?: ReactNode;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={className ? `dialog ${className}` : "dialog"}
      // A custom property, not `max-width`: an inline max-width would beat the
      // stylesheet and stop a variant becoming a full-width sheet on a phone.
      style={{ "--dialog-max-width": `${maxWidth}px` } as CSSProperties}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // The inner wrapper fills the dialog box, so only a click on the
        // backdrop itself has the <dialog> as its target.
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="dialog-inner">
        <button type="button" className="dialog-close" aria-label="ปิด" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
        <h2 className="dialog-title" id={titleId}>
          {title}
          {titleExtra}
        </h2>
        {description ? (
          <div className="dialog-body" id={descriptionId}>
            {description}
          </div>
        ) : null}
        {children}
      </div>
    </dialog>
  );
}
