import React from "react";
import { SpaLink } from "./SpaLink";

export function DashStat({ label, value, sub, icon, accent, href, onClick, active, className, valueClassName }: {
  label: string;
  value: number | string;
  sub: string;
  icon: React.ReactNode;
  accent: "teal" | "green" | "red" | "purple" | "blue" | "indigo" | "amber";
  href?: string;
  onClick?: () => void;
  active?: boolean;
  className?: string;
  valueClassName?: string;
}) {
  const body = (
    <>
      <div className="dash-stat-icon">{icon}</div>
      <div className="dash-stat-body">
        <strong className={["dash-stat-value", valueClassName].filter(Boolean).join(" ")}>{typeof value === "number" ? value.toLocaleString() : value}</strong>
        <span className="dash-stat-label">{label}</span>
        <span className="dash-stat-sub">{sub}</span>
      </div>
    </>
  );
  const cardClassName = `dash-stat dash-stat--${accent}${onClick ? " dash-stat--clickable" : ""}${active ? " dash-stat--active" : ""}${className ? ` ${className}` : ""}`;
  if (onClick) {
    if (href) {
      return <SpaLink href={href} className={cardClassName} onNavigate={onClick}>{body}</SpaLink>;
    }
    return <button type="button" className={cardClassName} onClick={onClick}>{body}</button>;
  }
  return <div className={cardClassName}>{body}</div>;
}
