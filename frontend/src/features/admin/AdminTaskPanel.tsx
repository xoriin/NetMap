import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** A labelled Admin task; inside another panel it renders as a popup-style section, not a second band. */
export function AdminTaskPanel({ title, icon, children, actions, className = "" }: {
  title: string;
  icon: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const [nested, setNested] = useState(false);

  useLayoutEffect(() => {
    setNested(Boolean(ref.current?.parentElement?.closest(".nm-app-panel, [data-admin-task]")));
  }, []);

  if (nested) {
    return (
      <section ref={ref} className={`mon-hero-section admin-task-panel admin-task-panel--nested ${className}`} aria-label={title} data-admin-task="">
        <div className="mon-hero-section-title admin-task-title">
          <h3 className="admin-task-heading"><span aria-hidden="true">{icon}</span>{title}</h3>
          {actions && <div className="admin-panel-actions">{actions}</div>}
        </div>
        <div className="admin-task-body">{children}</div>
      </section>
    );
  }

  return (
    <section ref={ref} className={`nm-app-panel admin-task-panel ${className}`} aria-label={title} data-admin-task="">
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
