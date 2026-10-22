import type { ReactNode } from "react";

/** A labelled task within an Admin workspace; appearance stays canonical. */
export function AdminTaskPanel({ title, icon, children, actions, className = "" }: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`nm-app-panel admin-task-panel ${className}`} aria-label={title} data-admin-task="">
      <div className="nm-app-panel-header">
        <div className="admin-panel-identity">
          <span className="nm-app-panel-icon" aria-hidden="true">{icon}</span>
          <h3 className="admin-section-title">{title}</h3>
        </div>
        {actions && <div className="admin-panel-actions">{actions}</div>}
      </div>
      <div className="admin-task-body">{children}</div>
    </section>
  );
}
