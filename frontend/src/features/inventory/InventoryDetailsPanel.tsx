import type { ReactNode } from "react";
import { X } from "lucide-react";

/** The original Devices sidebar frame, shared by every Inventory item detail view. */
export function InventoryDetailsPanel({ title, icon, onClose, children }: {
  title: string;
  icon: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <aside className="details-panel inventory-device-sidebar" aria-label={title}>
      <div className="inventory-device-sidebar-header">
        <span className="inventory-device-sidebar-title">
          <span className="inv-panel-title-icon" aria-hidden="true">{icon}</span>
          <span>{title}</span>
        </span>
        <button type="button" className="nm-btn nm-btn--icon"
          aria-label={`Close ${title.toLowerCase()}`} onClick={onClose}>
          <X size={17} />
        </button>
      </div>
      <div className="inventory-device-sidebar-body">{children}</div>
    </aside>
  );
}
