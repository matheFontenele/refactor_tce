import React from "react";

/**
 * Ícones vetoriais inline (stroke 1.75, 24x24).
 * Sem dependência externa: herda `currentColor` e os tokens do tema.
 * Decorativos ficam `aria-hidden`; controles recebem nome acessível via `title`.
 */
export type IconName =
  | "dashboard"
  | "search"
  | "code"
  | "sparkles"
  | "landmark"
  | "mapPin"
  | "calendar"
  | "coins"
  | "fileText"
  | "database"
  | "barChart"
  | "download"
  | "alertTriangle"
  | "x"
  | "check"
  | "copy"
  | "chevronRight"
  | "chevronDown"
  | "sliders"
  | "table"
  | "layoutGrid"
  | "history"
  | "save"
  | "play"
  | "arrowRight"
  | "info"
  | "refresh"
  | "loader"
  | "trash"
  | "car"
  | "shield";

const PATHS: Record<IconName, React.ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </>
  ),
  code: (
    <>
      <path d="m8 6-6 6 6 6" />
      <path d="m16 6 6 6-6 6" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
      <path d="M19 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" />
    </>
  ),
  landmark: (
    <>
      <path d="M3 21h18" />
      <path d="M5 21V10" />
      <path d="M9 21V10" />
      <path d="M15 21V10" />
      <path d="M19 21V10" />
      <path d="m12 3 8 5H4l8-5Z" />
    </>
  ),
  mapPin: (
    <>
      <path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z" />
      <circle cx="12" cy="10" r="2.5" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </>
  ),
  coins: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v5c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
      <path d="M4 11v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5" />
    </>
  ),
  fileText: (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6M8 13h8M8 17h6" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" />
    </>
  ),
  barChart: (
    <>
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 21h16" />
    </>
  ),
  alertTriangle: (
    <>
      <path d="M10.3 4.3 2.6 18a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4M12 17h.01" />
    </>
  ),
  x: <path d="M18 6 6 18M6 6l12 12" />,
  check: <path d="m5 12 4 4L19 6" />,
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  chevronRight: <path d="m9 18 6-6-6-6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  sliders: (
    <>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
      <path d="M2 14h4M10 8h4M18 16h4" />
    </>
  ),
  table: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M9 10v10" />
    </>
  ),
  layoutGrid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </>
  ),
  history: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 2" />
    </>
  ),
  save: (
    <>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
      <path d="M17 21v-8H7v8M7 3v5h8" />
    </>
  ),
  play: <path d="m7 4 13 8-13 8V4Z" />,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-14.9-4M4 4v5h5" />
      <path d="M4 13a8 8 0 0 0 14.9 4M20 20v-5h-5" />
    </>
  ),
  loader: <path d="M12 3a9 9 0 1 0 9 9" />,
  trash: (
    <>
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
    </>
  ),
  car: (
    <>
      <path d="M5 17H3v-5l2-5h12l2 5h2v5h-2" />
      <path d="M5 12h14M7 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM17 17a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
    </>
  ),
  shield: (
    <>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
};

export function Icon({
  name,
  className = "h-4 w-4",
  title,
}: {
  name: IconName;
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      className={className}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
