import type { ReactNode } from "react";

export type EventTone = "online" | "offline" | "warning" | "unknown" | "disabled";
export type EventRow = { key: string | number; tone: EventTone; title: ReactNode; detail?: ReactNode; time?: ReactNode; dateTime?: string };

/** Compact timeline rows: status dot, title, one line of detail and a right-aligned time. */
export function EventList({ rows, empty }: { rows: EventRow[]; empty: string }) {
  if (rows.length === 0) return <p className="tool-note nm-chart-empty">{empty}</p>;
  return (
    <ul className="nm-event-list">
      {rows.map((row) => (
        <li key={row.key}>
          <span className={`dash-status-dot dash-status-dot--${row.tone}`} aria-hidden="true" />
          <span><strong>{row.title}</strong>{row.detail && <small>{row.detail}</small>}</span>
          {row.time && <time dateTime={row.dateTime}>{row.time}</time>}
        </li>
      ))}
    </ul>
  );
}
