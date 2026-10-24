import { useEffect, useRef } from "react";
import { useTheme } from "../../providers/ThemeProvider";
import type { StatusPagePayload } from "./statusPagesApi";
import { buildStatusDocument } from "./renderer/buildStatusDocument";
import type { StatusColorScheme } from "./renderer/builtinStyles";
import "./statusPages.css";

type StatusPageFrameProps = {
  payload: StatusPagePayload;
  css: string | null;
  title: string;
  colorScheme?: StatusColorScheme;
  className?: string;
};

export function StatusPageFrame({ payload, css, title, colorScheme = null, className }: StatusPageFrameProps) {
  const { darkStyle } = useTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const shownRef = useRef<string | null>(null);
  const previousRef = useRef<StatusPagePayload | null>(null);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      // An opaque sandbox cannot receive key events while focus stays in the
      // parent. Send only this fixed dismissal signal, never page/user data.
      if (event.key === "Escape") frameRef.current?.contentWindow?.postMessage("netmap:status-heartbeat-dismiss", "*");
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, []);

  useEffect(() => {
    const documentHtml = buildStatusDocument(payload, {
      css, now: new Date(), colorScheme, darkStyle, previousPayload: previousRef.current,
    });
    previousRef.current = payload;
    const frame = frameRef.current;
    // Arrival markers are transient presentation, not changed content. Leaving a
    // completed animation in place avoids resetting disclosures on the next poll.
    const contentHtml = documentHtml.replace(/ sp-beat--new"/g, '"');
    const hasArrivals = contentHtml !== documentHtml;
    if (!frame || (!hasArrivals && shownRef.current === contentHtml)) return;
    frame.srcdoc = documentHtml;
    shownRef.current = contentHtml;
  }, [payload, css, colorScheme, darkStyle]);

  return (
    <iframe
      ref={frameRef}
      className={className ? `status-page-frame ${className}` : "status-page-frame"}
      style={{ colorScheme: colorScheme ?? "normal" }}
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts"
      referrerPolicy="no-referrer"
      title={title}
    />
  );
}
