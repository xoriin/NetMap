import { Fragment, type CSSProperties } from "react";
import "./authMotion.css";

/** Decorative entrance only: assistive technology reads the complete text once. */
export function AuthTextReveal({ text, active = true }: { text: string; active?: boolean }) {
  let wordIndex = 0;
  return (
    <span className={`auth-text-reveal${active ? " auth-text-reveal--active" : ""}`}>
      <span className="auth-text-reveal__accessible">{text}</span>
      <span aria-hidden="true">
        {text.split(/(\s+)/).map((part, index) => {
          if (!part.trim()) return <Fragment key={index}>{part}</Fragment>;
          const style = { "--auth-word-index": Math.min(wordIndex++, 18) } as CSSProperties;
          return <span className="auth-text-reveal__word" key={index} style={style}>{part}</span>;
        })}
      </span>
    </span>
  );
}
