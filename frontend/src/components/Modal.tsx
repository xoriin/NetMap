import React, { useEffect, useRef } from "react";
import { X } from "lucide-react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Counter so stacked modals only release the body scroll lock when the last one closes.
let openModalCount = 0;

function lockBodyScroll() {
  openModalCount += 1;
  if (openModalCount === 1) document.body.style.overflow = "hidden";
}

function unlockBodyScroll() {
  openModalCount = Math.max(0, openModalCount - 1);
  if (openModalCount === 0) document.body.style.overflow = "";
}

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
  dismissible = true,
  footer,
  headerActions,
  headerExtra,
  headerSubmitDisabled = false,
  headerSubmitFormId,
  headerSubmitLabel,
  modalClassName,
  onCancel,
  size = "md",
  title,
  titleIcon,
  wide = false,
}: {
  bodyClassName?: string;
  children: React.ReactNode;
  dismissible?: boolean;
  footer?: React.ReactNode;
  headerActions?: React.ReactNode;
  headerExtra?: React.ReactNode;
  headerSubmitDisabled?: boolean;
  headerSubmitFormId?: string;
  headerSubmitLabel?: string;
  modalClassName?: string;
  onCancel: () => void;
  size?: ModalSize;
  title: string;
  titleIcon?: React.ReactNode;
  wide?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (dismissible) onCancel();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      const inside = active !== null && dialog.contains(active);
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismissible, onCancel]);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    lockBodyScroll();
    const dialog = dialogRef.current;
    if (dialog && !dialog.contains(document.activeElement)) {
      const target =
        dialog.querySelector<HTMLElement>("[autofocus]") ??
        Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
          .find((el) => !el.classList.contains("modal-close-btn") && el.offsetParent !== null) ??
        dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      target?.focus();
    }
    return () => {
      unlockBodyScroll();
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => {
        if (dismissible && event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        className={[modalSizeClass(size, wide), modalClassName].filter(Boolean).join(" ")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div className="modal-header-title-wrap">
            {titleIcon}
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
            {headerActions}
            {dismissible && (
              <button type="button" className="nm-btn nm-btn--icon modal-close-btn" onClick={onCancel} aria-label="Close">
                <X size={18} />
              </button>
            )}
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
