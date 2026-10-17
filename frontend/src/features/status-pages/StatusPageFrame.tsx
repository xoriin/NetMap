import { useEffect, useMemo, useRef } from "react";
import type { StatusPagePayload } from "./statusPagesApi";
import { buildStatusDocument } from "./renderer/buildStatusDocument";
import "./statusPages.css";

type StatusPageFrameProps = {
  payload: StatusPagePayload;
  css: string | null;
  title: string;
  className?: string;
};

export function StatusPageFrame({ payload, css, title, className }: StatusPageFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const shownRef = useRef<string | null>(null);
  const documentHtml = useMemo(() => buildStatusDocument(payload, { css, now: new Date() }), [payload, css]);

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
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      title={title}
    />
  );
}
