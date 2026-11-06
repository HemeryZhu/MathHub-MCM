import type { Competition } from "../types";

type CompetitionCoverProps = {
  competition: Competition;
};

type CoverTheme = {
  from: string;
  to: string;
  accent: string;
  eyebrow: string;
};

const COVER_THEMES: Record<string, CoverTheme> = {
  "mcm-icm": { from: "#063970", to: "#1769aa", accent: "#7dd3fc", eyebrow: "GLOBAL CHALLENGE" },
  "kc-cup": { from: "#0f766e", to: "#0891b2", accent: "#99f6e4", eyebrow: "INNOVATION CUP" },
  "teddy-cup": { from: "#6d28d9", to: "#db2777", accent: "#f5d0fe", eyebrow: "DATA MINING" },
  mathorcup: { from: "#1e3a8a", to: "#2563eb", accent: "#bfdbfe", eyebrow: "OPERATIONS RESEARCH" },
  "huadong-cup": { from: "#9a3412", to: "#ea580c", accent: "#fed7aa", eyebrow: "EAST CHINA" },
  "huazhong-cup": { from: "#166534", to: "#0f766e", accent: "#bbf7d0", eyebrow: "CENTRAL CHINA" },
  "rz-china-1": { from: "#3730a3", to: "#7c3aed", accent: "#ddd6fe", eyebrow: "CERTIFICATION CUP" },
  "may-day": { from: "#991b1b", to: "#d97706", accent: "#fde68a", eyebrow: "MAY DAY CONTEST" },
  "zq-cup": { from: "#9f1239", to: "#e11d48", accent: "#fecdd3", eyebrow: "YOUTH CHALLENGE" },
  "csg-cup": { from: "#075985", to: "#0891b2", accent: "#bae6fd", eyebrow: "YANGTZE DELTA" },
  "sw-cup": { from: "#1d4ed8", to: "#4f46e5", accent: "#c7d2fe", eyebrow: "SHUWEI CUP" },
  "stat-modeling": { from: "#581c87", to: "#7e22ce", accent: "#e9d5ff", eyebrow: "STATISTICAL MODELING" },
  "electric-cup": { from: "#854d0e", to: "#ca8a04", accent: "#fef08a", eyebrow: "ELECTRICAL MODELING" },
  "ne-provinces": { from: "#164e63", to: "#0284c7", accent: "#cffafe", eyebrow: "NORTHEAST LEAGUE" },
  "data-stat-analysis": { from: "#065f46", to: "#059669", accent: "#a7f3d0", eyebrow: "DATA & STATISTICS" },
  "school-contest": { from: "#334155", to: "#475569", accent: "#cbd5e1", eyebrow: "CAMPUS SELECTION" },
  "shenzhen-cup": { from: "#0e7490", to: "#7c3aed", accent: "#a5f3fc", eyebrow: "SHENZHEN CUP" },
  "huashu-cup": { from: "#4c1d95", to: "#9333ea", accent: "#e9d5ff", eyebrow: "HUASHU CUP" },
  cumcm: { from: "#991b1b", to: "#dc2626", accent: "#fecaca", eyebrow: "NATIONAL CONTEST" },
  huawei: { from: "#7f1d1d", to: "#be123c", accent: "#fecdd3", eyebrow: "GRADUATE CONTEST" },
  "sw-intl": { from: "#312e81", to: "#4f46e5", accent: "#c7d2fe", eyebrow: "INTERNATIONAL CUP" },
  apmcm: { from: "#92400e", to: "#b91c1c", accent: "#fde68a", eyebrow: "ASIA-PACIFIC" },
  "gda-finance": { from: "#0f172a", to: "#0e7490", accent: "#fcd34d", eyebrow: "FINANCIAL MODELING" },
  "rz-china-intl": { from: "#312e81", to: "#6d28d9", accent: "#ddd6fe", eyebrow: "INTERNATIONAL CHALLENGE" },
  "china-bigdata": { from: "#3b0764", to: "#a21caf", accent: "#f5d0fe", eyebrow: "BIG DATA FINALS" },
};

const FALLBACK_THEME: CoverTheme = {
  from: "#0f4c81",
  to: "#2563eb",
  accent: "#bfdbfe",
  eyebrow: "MATH MODELING",
};

export default function CompetitionCover({ competition }: CompetitionCoverProps) {
  const theme = COVER_THEMES[competition.id] || FALLBACK_THEME;

  return (
    <div
      className="relative isolate h-44 overflow-hidden border-b border-white/15 p-5 text-white lg:h-auto lg:min-h-full lg:border-b-0 lg:border-r"
      style={{ background: `linear-gradient(145deg, ${theme.from}, ${theme.to})` }}
      role="img"
      aria-label={`${competition.name}主题插画`}
      data-testid={`competition-cover-${competition.id}`}
    >
      <svg
        className="absolute inset-0 -z-10 h-full w-full opacity-80"
        viewBox="0 0 320 420"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <pattern id={`grid-${competition.id}`} width="28" height="28" patternUnits="userSpaceOnUse">
            <path d="M 28 0 L 0 0 0 28" fill="none" stroke="white" strokeOpacity="0.08" strokeWidth="1" />
          </pattern>
          <linearGradient id={`fade-${competition.id}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="white" stopOpacity="0.2" />
            <stop offset="100%" stopColor={theme.accent} stopOpacity="0.03" />
          </linearGradient>
        </defs>
        <rect width="320" height="420" fill={`url(#grid-${competition.id})`} />
        <circle cx="268" cy="44" r="96" fill={`url(#fade-${competition.id})`} />
        <circle cx="42" cy="360" r="112" fill="white" fillOpacity="0.05" />
        <path
          d="M-30 330 C55 255 92 382 164 298 S278 212 350 270"
          fill="none"
          stroke={theme.accent}
          strokeOpacity="0.42"
          strokeWidth="3"
        />
        <path
          d="M-20 354 C70 278 114 396 188 318 S284 248 348 292"
          fill="none"
          stroke="white"
          strokeOpacity="0.18"
          strokeWidth="1.5"
        />
      </svg>

      <div className="flex h-full flex-col justify-between gap-3">
        <div className="flex items-start justify-between gap-3">
          <span className="text-[10px] font-extrabold tracking-[0.18em] text-white/75">
            {theme.eyebrow}
          </span>
          <span className="rounded-full border border-white/25 bg-white/10 px-2 py-0.5 text-[10px] font-bold backdrop-blur-sm">
            {competition.month} 月
          </span>
        </div>

        <div className="flex items-end justify-between gap-4 lg:block">
          <div
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl border border-white/25 bg-white/15 text-4xl shadow-lg backdrop-blur-sm lg:mb-5 lg:h-20 lg:w-20 lg:text-5xl"
            aria-hidden="true"
          >
            {competition.logoChar}
          </div>
          <div className="min-w-0 text-right lg:text-left">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/60">Competition</p>
            <p className="mt-0.5 truncate text-xl font-black tracking-tight lg:whitespace-normal lg:text-2xl">
              {competition.alias}
            </p>
            <div className="mt-2 hidden items-center gap-1.5 lg:flex">
              {Array.from({ length: 5 }).map((_, index) => (
                <span
                  key={index}
                  className="h-1.5 flex-1 rounded-full"
                  style={{ backgroundColor: index < competition.difficulty ? theme.accent : "rgba(255,255,255,0.18)" }}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
