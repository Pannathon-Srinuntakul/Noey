"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

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
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  maxWidth?: number;
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
      className="dialog"
      style={{ maxWidth }}
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
        <h2 className="dialog-title" id={titleId}>
          {title}
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
