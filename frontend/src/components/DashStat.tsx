import React from "react";
import { SpaLink } from "./SpaLink";

export function DashStat({ label, value, sub, icon, accent, href, onClick, active }: {
  label: string;
  value: number | string;
  sub: string;
  icon: React.ReactNode;
  accent: "teal" | "green" | "red" | "purple" | "blue" | "indigo";
  href?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const body = (
    <>
      <div className="dash-stat-icon">{icon}</div>
      <div className="dash-stat-body">
        <strong className="dash-stat-value">{typeof value === "number" ? value.toLocaleString() : value}</strong>
        <span className="dash-stat-label">{label}</span>
        <span className="dash-stat-sub">{sub}</span>
      </div>
    </>
  );
  const className = `dash-stat dash-stat--${accent}${onClick ? " dash-stat--clickable" : ""}${active ? " dash-stat--active" : ""}`;
  if (onClick) {
    if (href) {
      return <SpaLink href={href} className={className} onNavigate={onClick}>{body}</SpaLink>;
    }
    return <button type="button" className={className} onClick={onClick}>{body}</button>;
  }
  return <div className={className}>{body}</div>;
}
