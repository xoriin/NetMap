import { useEffect, useMemo, useRef } from "react";
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
  const frameRef = useRef<HTMLIFrameElement>(null);
  const shownRef = useRef<string | null>(null);
  const documentHtml = useMemo(
    () => buildStatusDocument(payload, { css, now: new Date(), colorScheme }),
    [payload, css, colorScheme],
  );

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || shownRef.current === documentHtml) return;
    frame.srcdoc = documentHtml;
    shownRef.current = documentHtml;
  }, [documentHtml]);

  return (
    <iframe
      ref={frameRef}
      className={className ? `status-page-frame ${className}` : "status-page-frame"}
      style={{ colorScheme: colorScheme ?? "normal" }}
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      title={title}
    />
  );
}
