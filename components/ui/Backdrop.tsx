/**
 * The flowing light ribbons and glows behind every screen. Purely decorative and fixed, so it
 * never adds to the page's height.
 */
export function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden bg-bg">
      <div className="absolute -top-1/3 -left-1/4 size-[70vmax] rounded-pill bg-glow-indigo/30 blur-3xl" />
      <div className="absolute -right-1/4 -bottom-1/2 size-[60vmax] rounded-pill bg-glow-violet/20 blur-3xl" />
      <div className="absolute top-1/2 -left-1/3 size-[40vmax] rounded-pill bg-glow-blue/10 blur-3xl" />

      <svg className="absolute inset-0 size-full" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" fill="none">
        <defs>
          <linearGradient id="ribbon-top" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="var(--color-glow-indigo)" stopOpacity="0" />
            <stop offset="0.5" stopColor="var(--color-glow-violet)" stopOpacity="0.8" />
            <stop offset="1" stopColor="var(--color-glow-blue)" stopOpacity="0.3" />
          </linearGradient>
          <linearGradient id="ribbon-bottom" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--color-glow-blue)" stopOpacity="0.7" />
            <stop offset="0.45" stopColor="var(--color-glow-violet)" stopOpacity="0.5" />
            <stop offset="1" stopColor="var(--color-glow-violet)" stopOpacity="0" />
          </linearGradient>
          <filter id="ribbon-blur">
            <feGaussianBlur stdDeviation="1.2" />
          </filter>
        </defs>

        {/* A sheet of fine lines sweeping in from the top right, like the template's hero. */}
        <g stroke="url(#ribbon-top)" strokeWidth="1" filter="url(#ribbon-blur)" opacity="0.55">
          {Array.from({ length: 18 }, (_, i) => (
            <path key={i} d={`M ${560 + i * 22} -40 C ${820 + i * 18} ${180 + i * 6}, ${980 + i * 10} ${120 + i * 14}, 1500 ${360 + i * 16}`} />
          ))}
        </g>
        <path
          d="M 640 -60 C 900 220, 1080 160, 1500 420 L 1500 300 C 1120 80, 960 160, 760 -60 Z"
          fill="url(#ribbon-top)"
          opacity="0.18"
        />

        {/* The low wave of light along the bottom, like the template's call to action. */}
        <path
          d="M -40 820 C 300 760, 620 720, 900 770 C 1120 810, 1300 760, 1480 700"
          stroke="url(#ribbon-bottom)"
          strokeWidth="2"
          filter="url(#ribbon-blur)"
          opacity="0.7"
        />
        <path d="M -40 860 C 340 790, 640 760, 960 800 C 1160 826, 1320 790, 1480 750 L 1480 940 L -40 940 Z" fill="url(#ribbon-bottom)" opacity="0.12" />
      </svg>

      {/* Fades the art toward the middle so text over it stays readable. */}
      <div className="absolute inset-0 bg-radial from-bg/0 via-bg/40 to-bg/80" />
    </div>
  );
}
