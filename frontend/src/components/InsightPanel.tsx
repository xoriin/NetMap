import { ChartPanel, ChartOptionsSlot } from "./ChartPanel";
import type { ReactNode } from "react";

/** A canonical panel holding a chart or short list beside or above a page's main table. */
export function InsightPanel({ title, icon, actions, children, className = "", label }: {
  title: string;
  icon: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  label?: string;
}) {
  return (
    <ChartPanel><section className={`dash-panel nm-app-panel nm-insight ${className}`.trim()} aria-label={label ?? title}>
      <div className="nm-app-panel-header nm-insight-header">
        <div className="nm-insight-title"><span className="nm-app-panel-icon" aria-hidden="true">{icon}</span><strong>{title}</strong></div>
        <ChartOptionsSlot>{actions}</ChartOptionsSlot>
      </div>
      <div className="dash-panel-body nm-chart-body">{children}</div>
    </section></ChartPanel>
  );
}
