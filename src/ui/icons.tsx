// Line icons for the singing console (one stroke weight, drawn on a 24 grid): no emoji in controls.
import type { ReactNode } from 'react';

const P: Record<string, ReactNode> = {
  play: <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />,
  pause: <path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor" stroke="none" />,
  back: (
    <>
      <path d="M11 6 5 12l6 6" />
      <path d="M19 6l-6 6 6 6" />
    </>
  ),
  fwd: (
    <>
      <path d="m13 6 6 6-6 6" />
      <path d="m5 6 6 6-6 6" />
    </>
  ),
  skip: (
    <>
      <path d="m5 5 9 7-9 7z" />
      <path d="M19 5v14" />
    </>
  ),
  left: <path d="m14 6-6 6 6 6" />,
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
    </>
  ),
  sliders: (
    <>
      <path d="M5 4v6M5 14v6M12 4v2M12 10v10M19 4v9M19 17v3" />
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="8" r="2" />
      <circle cx="19" cy="15" r="2" />
    </>
  ),
  grid: (
    <>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" />
    </>
  ),
  max: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  min: <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />,
  minus: <path d="M6 12h12" />,
  plus: <path d="M6 12h12M12 6v12" />,
  star: <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" fill="currentColor" stroke="none" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  next: (
    <>
      <path d="m6 5 9 7-9 7z" fill="currentColor" stroke="none" />
      <path d="M18.5 5v14" />
    </>
  ),
  redo: <path d="M4 12a8 8 0 1 0 2.6-5.9M4 4v5h5" />,
  flag: <path d="M6 21V4h11l-2 4 2 4H6" />,
};

export function Icon({ name, size = 20 }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name]}
    </svg>
  );
}
