// SPDX-License-Identifier: Apache-2.0
//
// Minimal 16/20 px stroke icon set for the prototype (1.5 px strokes, currentColor). Directional glyphs
// carry the `flip-rtl` class so they mirror in Arabic; symbolic glyphs (play, check, gear) never mirror.
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconHome = (p: P) => (
  <Svg {...p}>
    <path d="M3 9.5 10 4l7 5.5V16a1 1 0 0 1-1 1h-3.5v-4.5h-5V17H4a1 1 0 0 1-1-1z" />
  </Svg>
);
export const IconStudio = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="14" height="12" rx="1.5" />
    <path d="M8 4v12M3 8h5" />
  </Svg>
);
export const IconActivity = (p: P) => (
  <Svg {...p}>
    <path d="M3 10h3l2-5 4 10 2-5h3" />
  </Svg>
);
export const IconAssets = (p: P) => (
  <Svg {...p}>
    <path d="m10 3 6.5 3.5v7L10 17l-6.5-3.5v-7z" />
    <path d="M3.5 6.5 10 10l6.5-3.5M10 10v7" />
  </Svg>
);
export const IconTest = (p: P) => (
  <Svg {...p}>
    <path d="m4 10.5 3.5 3.5L16 5.5" />
  </Svg>
);
export const IconBuilds = (p: P) => (
  <Svg {...p}>
    <path d="M10 3v10m0 0-4-4m4 4 4-4M4 16h12" />
  </Svg>
);
export const IconWorkers = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="4" width="14" height="5" rx="1" />
    <rect x="3" y="11" width="14" height="5" rx="1" />
    <path d="M6 6.5h.01M6 13.5h.01" />
  </Svg>
);
export const IconApprovals = (p: P) => (
  <Svg {...p}>
    <path d="M5 17V3.5M5 4h9l-2 3 2 3H5" />
  </Svg>
);
export const IconSettings = (p: P) => (
  <Svg {...p}>
    <circle cx="10" cy="10" r="2.5" />
    <path d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4" />
  </Svg>
);
export const IconSearch = (p: P) => (
  <Svg {...p}>
    <circle cx="9" cy="9" r="5" />
    <path d="m13 13 4 4" />
  </Svg>
);
export const IconChevron = (p: P) => (
  <Svg {...p} className={`flip-rtl ${p.className ?? ''}`}>
    <path d="m8 5 5 5-5 5" />
  </Svg>
);
export const IconSend = (p: P) => (
  <Svg {...p} className={`flip-rtl ${p.className ?? ''}`}>
    <path d="M3.5 10h11M10 5l5 5-5 5" />
  </Svg>
);
export const IconPause = (p: P) => (
  <Svg {...p}>
    <path d="M7 4.5v11M13 4.5v11" />
  </Svg>
);
export const IconPlay = (p: P) => (
  <Svg {...p}>
    <path d="M6.5 4.5v11l9-5.5z" />
  </Svg>
);
export const IconAlert = (p: P) => (
  <Svg {...p}>
    <path d="M10 3.5 17.5 16.5h-15z" />
    <path d="M10 8.5v3.5M10 14.5h.01" />
  </Svg>
);
export const IconLock = (p: P) => (
  <Svg {...p}>
    <rect x="4.5" y="9" width="11" height="8" rx="1.5" />
    <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
  </Svg>
);
export const IconInbox = (p: P) => (
  <Svg {...p}>
    <path d="M3 11.5 5 4.5h10l2 7V16H3z" />
    <path d="M3 11.5h4l1 2h4l1-2h4" />
  </Svg>
);
export const IconPlus = (p: P) => (
  <Svg {...p}>
    <path d="M10 4.5v11M4.5 10h11" />
  </Svg>
);
export const IconCopy = (p: P) => (
  <Svg {...p}>
    <rect x="7" y="7" width="9" height="9" rx="1.5" />
    <path d="M13 7V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2" />
  </Svg>
);

/** The Module Keystone mark (concept A) as an inline component, for the rail + wordmark. */
export function KeystoneMark({ size = 28 }: { size?: number }) {
  return <img src={`${import.meta.env.BASE_URL}prototype/icon.svg`} width={size} height={size} alt="" />;
}
