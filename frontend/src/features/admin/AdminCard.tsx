import type { CSSProperties, ReactNode } from "react";

/** An Admin module card with the canonical header; matches the System tab's chart and side cards. */
export function AdminCard({ title, icon, actions, children, className = "", label, id, style, body = true }: {
  title: string;
  icon: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  label?: string;
  id?: string;
  style?: CSSProperties;
  body?: boolean;
}) {
  return (
    <section id={id} className={`panel admin-panel nm-app-panel admin-system-card nm-motion-item ${className}`.trim()} aria-label={label ?? title} style={style}>
      <div className="admin-system-card-header nm-app-panel-header">
        <h2 className="admin-section-title">{icon}{title}</h2>
        {actions}
      </div>
      {body ? <div className="nm-chart-body">{children}</div> : children}
    </section>
  );
}
