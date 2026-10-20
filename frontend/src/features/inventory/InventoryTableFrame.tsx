import { ChevronDown, ChevronUp } from "lucide-react";
import type { CSSProperties, MouseEvent, ReactNode, Ref } from "react";

/** The Devices table owns Inventory's table chrome. All Inventory views use it. */
export function InventoryTableFrame({ toolbar, header, headerRef, tableStyle, fixed = false, children, footer }: {
  toolbar: ReactNode; header: ReactNode; headerRef?: Ref<HTMLDivElement>;
  tableStyle?: CSSProperties; fixed?: boolean; children: ReactNode; footer?: ReactNode;
}) {
  return <div className="inventory-surface nm-app-panel">
    <div className="inventory-panel-header nm-app-panel-header">{toolbar}</div>
    <div className={`inventory-table${fixed ? " inventory-table--fixed" : ""}`} style={tableStyle}>
      <div className="inventory-table-header" ref={headerRef}>{header}</div>
      {children}
    </div>
    {footer}
  </div>;
}

export function InventoryColumnHeading({ children, active, ascending, onSort, onResize, onReset }: {
  children: ReactNode; active?: boolean; ascending?: boolean; onSort: () => void;
  onResize?: (event: MouseEvent) => void; onReset?: () => void;
}) {
  return <span className="inventory-th">
    <button type="button" className={`inventory-sort-btn${active ? " active" : ""}`} onClick={onSort}>
      {children}{active && (ascending ? <ChevronUp size={11} /> : <ChevronDown size={11} />)}
    </button>
    {onResize && <span role="separator" aria-orientation="vertical" className="inventory-col-resize-handle"
      title="Drag to resize · double-click to reset all columns" onMouseDown={onResize} onDoubleClick={onReset} />}
  </span>;
}

export function InventoryPagination({ total, page, pageSize, noun, onPageChange, onPageSizeChange }: {
  total: number; page: number; pageSize: number; noun: string;
  onPageChange: (page: number) => void; onPageSizeChange: (size: number) => void;
}) {
  return <div className="inv-pagination">
    <span className="inv-pagination-info">Showing {Math.min((page - 1) * pageSize + 1, total)}–{Math.min(page * pageSize, total)} of {total} {noun}</span>
    <div className="inv-pagination-controls">
      <span style={{ fontSize: 11, opacity: 0.7 }}>Per page:</span>
      <select aria-label="Rows per page" className="inv-pagination-select" value={pageSize} onChange={event => onPageSizeChange(Number(event.target.value))}>
        {[10, 25, 50, 100].map(size => <option key={size} value={size}>{size}</option>)}
      </select>
      <button type="button" className="inv-pagination-btn" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>‹ Prev</button>
      <span style={{ fontSize: 12, whiteSpace: "nowrap" }}>{page} / {Math.max(1, Math.ceil(total / pageSize))}</span>
      <button type="button" className="inv-pagination-btn" disabled={page >= Math.ceil(total / pageSize)} onClick={() => onPageChange(page + 1)}>Next ›</button>
    </div>
  </div>;
}
