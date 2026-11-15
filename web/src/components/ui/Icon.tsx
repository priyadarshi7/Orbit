import type { ReactNode } from "react";

/** Line icons (24px grid, currentColor). Sized with Tailwind: <Icon.copy className="size-4" />. */
type P = { className?: string };

const make = (paths: ReactNode, filled = false) =>
  function IconSvg({ className = "size-4" }: P) {
    return (
      <svg
        viewBox="0 0 24 24"
        aria-hidden
        className={`shrink-0 ${className}`}
        fill={filled ? "currentColor" : "none"}
        stroke={filled ? "none" : "currentColor"}
        strokeWidth={1.7}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {paths}
      </svg>
    );
  };

export const Icon = {
  plus: make(<path d="M12 5v14M5 12h14" />),
  x: make(<path d="M6 6l12 12M18 6L6 18" />),
  menu: make(<path d="M4 7h16M4 12h16M4 17h16" />),
  arrowUp: make(<path d="M12 19V5M5 12l7-7 7 7" />),
  arrowDown: make(<path d="M12 5v14M5 12l7 7 7-7" />),
  arrowRight: make(<path d="M5 12h14M13 6l6 6-6 6" />),
  chevron: make(<path d="M9 6l6 6-6 6" />),
  search: make(<><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></>),
  stop: make(<rect x="7" y="7" width="10" height="10" rx="2" />, true),
  copy: make(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 012-2h9" /></>),
  check: make(<path d="M5 12.5l4.5 4.5L19 7.5" />),
  refresh: make(<path d="M20 12a8 8 0 11-2.3-5.7M20 4v5h-5" />),
  brain: make(<path d="M9 4a3 3 0 00-3 3v.5A3 3 0 004 10.5 3 3 0 005 13a3 3 0 001 5 3 3 0 006 0V4a3 3 0 00-3 0zM15 4a3 3 0 013 3v.5a3 3 0 012 3 3 3 0 01-1 2.5 3 3 0 01-1 5 3 3 0 01-6 0" />),
  chart: make(<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />),
  sun: make(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  pencil: make(<path d="M4 20h4L19 9a2.1 2.1 0 00-3-3L5 17v3zM14 7l3 3" />),
  moon: make(<path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z" />),
};
