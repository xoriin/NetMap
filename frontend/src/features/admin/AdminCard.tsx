import { ChartPanel, ChartOptionsSlot } from "../../components/ChartPanel";
import type { CSSProperties, ReactNode } from "react";

/** An Admin module card with the canonical header; matches the System tab's chart and side cards. */
export function AdminCard({ title, icon, actions, children, className = "", label, id, style, body = true, hero = false }: {
  title: string;
  icon: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  label?: string;
  id?: string;
  style?: CSSProperties;
  body?: boolean;
  hero?: boolean;
}) {
  return (
    <ChartPanel><section id={id} className={`panel admin-panel nm-app-panel admin-system-card nm-motion-item${hero ? " nm-hero-visual" : ""} ${className}`.trim()} aria-label={label ?? title} style={style}>
      <div className="admin-system-card-header nm-app-panel-header">
        <h2 className="admin-section-title">{icon}{title}</h2>
        <ChartOptionsSlot>{actions}</ChartOptionsSlot>
      </div>
      {body ? <div className="nm-chart-body">{children}</div> : children}
    </section></ChartPanel>
  );
}
