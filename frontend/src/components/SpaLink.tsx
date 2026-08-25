import {
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

type SpaLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  children: ReactNode;
  href: string;
  onNavigate: () => void;
};

/**
 * A real link that keeps ordinary left-clicks inside the SPA.
 *
 * Modified clicks, middle-clicks, and the browser context menu retain native anchor
 * behaviour, so users can open destinations in a new tab or window. Only an unmodified
 * primary click is intercepted and handed to NetMap's route state.
 */
export function SpaLink({ children, href, onClick, onNavigate, target, ...props }: SpaLinkProps) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    onClick?.(event);
    if (
      event.defaultPrevented
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
      || (target !== undefined && target !== "_self")
    ) {
      return;
    }

    event.preventDefault();
    onNavigate();
  }

  return (
    <a href={href} target={target} onClick={handleClick} {...props}>
      {children}
    </a>
  );
}
