import React, { useEffect } from "react";
import { X } from "lucide-react";

export type ModalSize = "sm" | "md" | "lg" | "xl";

function modalSizeClass(size: ModalSize, wide: boolean) {
  if (wide || size === "xl") return "modal modal--wide";
  if (size === "sm") return "modal modal--sm";
  if (size === "lg") return "modal modal--lg";
  return "modal";
}

export function Modal({
  bodyClassName,
  children,
  footer,
  headerExtra,
  headerSubmitDisabled = false,
  headerSubmitFormId,
  headerSubmitLabel,
  modalClassName,
  onCancel,
  size = "md",
  title,
  wide = false,
}: {
  bodyClassName?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  headerExtra?: React.ReactNode;
  headerSubmitDisabled?: boolean;
  headerSubmitFormId?: string;
  headerSubmitLabel?: string;
  modalClassName?: string;
  onCancel: () => void;
  size?: ModalSize;
  title: string;
  wide?: boolean;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className={[modalSizeClass(size, wide), modalClassName].filter(Boolean).join(" ")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-header-title-wrap">
            <h3>{title}</h3>
            {headerExtra}
          </div>
          <div className="modal-header-actions">
            {headerSubmitLabel && headerSubmitFormId && (
              <button
                type="submit"
                className="nm-btn nm-btn--sm nm-btn--primary"
                form={headerSubmitFormId}
                disabled={headerSubmitDisabled}
              >
                {headerSubmitLabel}
              </button>
            )}
            <button type="button" className="nm-btn nm-btn--icon modal-close-btn" onClick={onCancel} aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>
        {bodyClassName ? <div className={bodyClassName}>{children}</div> : children}
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

export function ModalFooterActions({
  cancelLabel = "Cancel",
  children,
  onCancel,
  primaryDisabled = false,
  primaryLabel,
  primaryType = "submit",
  formId,
}: {
  cancelLabel?: string;
  children?: React.ReactNode;
  onCancel: () => void;
  primaryDisabled?: boolean;
  primaryLabel: string;
  primaryType?: "button" | "submit";
  formId?: string;
}) {
  return (
    <>
      <button type="button" className="nm-btn" onClick={onCancel}>
        {cancelLabel}
      </button>
      {children}
      <button
        type={primaryType}
        className="nm-btn nm-btn--primary"
        form={formId}
        disabled={primaryDisabled}
      >
        {primaryLabel}
      </button>
    </>
  );
}
