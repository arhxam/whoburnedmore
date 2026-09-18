/** Public, versioned aggregate contract. Never include sessions or credentials. */
export const EMBED_STYLES = [
  "signature",
  "activity",
  "breakdown",
  "heatmap",
  "stats",
  "compact",
  "badge",
] as const;
export const EMBED_THEMES = ["dark", "light"] as const;
export const EMBED_ACCENTS = ["ember", "mono", "mint", "violet"] as const;
export const USAGE_PERIODS = [
  "today",
  "week",
  "7d",
  "30d",
  "year",
  "all",
] as const;
export type EmbedStyle = (typeof EMBED_STYLES)[number];
export type UsagePeriod = (typeof USAGE_PERIODS)[number];
export interface EmbedOptions {
  style: EmbedStyle;
  theme: (typeof EMBED_THEMES)[number];
  accent: (typeof EMBED_ACCENTS)[number];
  period: UsagePeriod;
}
export interface UsageSnapshot {
  schemaVersion: 1;
  handle: string;
  period: UsagePeriod;
  from: string | null;
  to: string;
  timezoneOffsetMinutes: number;
  generatedAt: string;
  lastSyncedAt: string | null;
  freshness: "fresh" | "stale" | "never";
  coverage: "synced-history" | "limited-history";
  visibility: "public" | "owner";
  totals: {
    tokens: number;
    costUSD: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    activeDays: number;
  };
  daily: Array<{ date: string; tokens: number; costUSD: number }>;
  byTool: Array<{ tool: string; tokens: number; costUSD: number }>;
  byModel: Array<{ model: string; tokens: number; costUSD: number }>;
  /** Calendar totals in the account's timezone, independent of the card window. */
  highlights?: { today: number; week: number; year: number };
  /** Last 84 local calendar days, with zero-filled gaps. */
  activity?: Array<{ date: string; tokens: number }>;
}
export interface EmbedAccountPreview {
  handle: string;
  snapshot: UsageSnapshot;
  embeddable: boolean;
}
export const DEFAULT_EMBED_OPTIONS: EmbedOptions = {
  style: "signature",
  theme: "dark",
  accent: "ember",
  period: "30d",
};
export const EMBED_HANDLE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function parseEmbedOptions(params: {
  get(key: string): string | null;
  getAll(key: string): string[];
  keys(): IterableIterator<string>;
}): EmbedOptions {
  const read = <T extends string>(
    key: string,
    values: readonly T[],
    fallback: T,
  ): T => {
    const value = params.get(key);
    if (
      params.getAll(key).length > 1 ||
      (value !== null && !values.includes(value as T))
    )
      throw new Error(`Invalid ${key}`);
    return (value ?? fallback) as T;
  };
  for (const key of params.keys())
    if (!["style", "theme", "accent", "period"].includes(key))
      throw new Error(`Unknown option: ${key}`);
  return {
    style: read("style", EMBED_STYLES, "signature"),
    theme: read("theme", EMBED_THEMES, "dark"),
    accent: read("accent", EMBED_ACCENTS, "ember"),
    period: read("period", USAGE_PERIODS, "30d"),
  };
}
export function embedQuery(options: EmbedOptions): string {
  return Object.entries(options)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join("&");
}
export function formatEmbedTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  for (const [unit, scale] of [
    ["T", 1e12],
    ["B", 1e9],
    ["M", 1e6],
    ["K", 1e3],
  ] as const) {
    if (n >= scale)
      return `${(n / scale).toFixed(1).replace(/\.0$/, "")}${unit}`;
  }
  return String(Math.round(n));
}
function xml(s: unknown): string {
  return String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[c]!,
    );
}
export function periodLabel(period: UsagePeriod): string {
  return {
    today: "TODAY",
    week: "THIS WEEK",
    "7d": "LAST 7 DAYS",
    "30d": "LAST 30 DAYS",
    year: "THIS YEAR",
    all: "ALL TIME",
  }[period];
}
export function burnLabel(period: UsagePeriod): string {
  return {
    today: "Burned today",
    week: "Burned this week",
    "7d": "Burned in 7 days",
    "30d": "Burned in 30 days",
    year: "Burned this year",
    all: "Burned all time",
  }[period];
}
/** Input day already reflects the account timezone; weeks start on Monday. */
export function usageWindowStart(
  period: UsagePeriod,
  day: string,
): string | null {
  if (period === "all") return null;
  if (period === "today") return day;
  if (period === "year") return `${day.slice(0, 4)}-01-01`;
  const date = new Date(`${day}T00:00:00Z`);
  const days =
    period === "week" ? (date.getUTCDay() + 6) % 7 : period === "7d" ? 6 : 29;
  return new Date(date.getTime() - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Self-contained SVG: fixed palettes, escaped text, no scripts or remote assets. */
export function renderUsageCard(
  data: UsageSnapshot | null,
  options: EmbedOptions,
  message = "Usage unavailable",
): string {
  const { style, theme, accent } = options;
  const light = theme === "light";
  const bg = light ? "#ffffff" : "#171717",
    panel = light ? "#f3f3f3" : "#242424";
  const fg = light ? "#171717" : "#fafafa",
    muted = light ? "#737373" : "#a3a3a3",
    line = light ? "#e5e5e5" : "#303030";
  const color = {
    ember: light ? "#c75013" : "#f97316",
    mono: light ? "#171717" : "#fafafa",
    mint: light ? "#13754b" : "#a4ecc2",
    violet: light ? "#7150b4" : "#c4b1ff",
  }[accent];
  const [w, h] =
    style === "badge"
      ? [440, 32]
      : style === "compact"
        ? [560, 100]
        : [560, 320];
  const text = (
    x: number,
    y: number,
    value: unknown,
    size = 12,
    fill = muted,
    extra = "",
  ) =>
    `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${xml(value)}</text>`;
  const rect = (
    x: number,
    y: number,
    width: number,
    height: number,
    fill: string,
    radius = 0,
  ) =>
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}"/>`;
  const headline = data
    ? `${formatEmbedTokens(data.totals.tokens)} tokens`
    : message;
  const date = data?.lastSyncedAt?.slice(0, 10);
  const status = !data
    ? "Try again later"
    : data.freshness === "never"
      ? "No published usage yet"
      : `${data.freshness === "stale" ? "Sync paused" : "Synced"} · ${date} UTC${data.coverage === "limited-history" ? " · partial history" : ""}`;
  const handle = data
    ? `@${data.handle.length > 27 ? data.handle.slice(0, 25) + "…" : data.handle}`
    : "whoburnedmore";
  let body = rect(0.5, 0.5, w - 1, h - 1, bg, style === "badge" ? 6 : 16);
  if (style === "badge") {
    body +=
      rect(0, 0, 133, h, panel, 6) +
      text(12, 21, "whoburnedmore", 12, fg) +
      text(
        145,
        21,
        data
          ? `${formatEmbedTokens(data.totals.tokens)} tokens · ${burnLabel(options.period).toLowerCase()}`
          : headline,
        11,
        color,
      );
  } else if (style === "compact") {
    body +=
      rect(20, 25, 3, 48, color, 1) +
      text(36, 36, handle, 13, fg) +
      text(36, 58, "whoburnedmore.com", 11) +
      text(36, 79, status, 9);
    body +=
      text(
        535,
        42,
        headline,
        25,
        color,
        'text-anchor="end" font-weight="700"',
      ) +
      text(535, 65, burnLabel(options.period), 10, muted, 'text-anchor="end"');
  } else {
    body +=
      text(26, 32, handle, 12, fg, 'font-weight="600"') +
      text(
        534,
        32,
        periodLabel(options.period),
        9,
        muted,
        'text-anchor="end" letter-spacing="1"',
      );
    body +=
      text(
        26,
        85,
        data ? formatEmbedTokens(data.totals.tokens) : "—",
        44,
        fg,
        'font-weight="700" letter-spacing="-1.8"',
      ) +
      text(
        27,
        106,
        data ? `tokens · ${burnLabel(options.period).toLowerCase()}` : message,
        11,
      );
    body +=
      text(
        534,
        74,
        data
          ? options.period !== "today" && data.highlights
            ? `${formatEmbedTokens(data.highlights.today)} burned today`
            : `${data.totals.activeDays} active days`
          : "No data available",
        13,
        fg,
        'text-anchor="end"',
      ) +
      text(
        534,
        96,
        data
          ? `$${data.totals.costUSD < 1000 ? data.totals.costUSD.toFixed(2) : formatEmbedTokens(data.totals.costUSD)} est. API value`
          : "",
        11,
        muted,
        'text-anchor="end"',
      );
    const days =
      options.period === "today" && data?.activity
        ? data.activity.slice(-30)
        : (data?.daily.slice(-30) ?? []);
    const max = Math.max(1, ...days.map((d) => d.tokens));
    const chartLabel =
      options.period === "today"
        ? "Daily tokens · last 30 days"
        : options.period === "week"
          ? "Daily tokens · this week"
          : `Daily tokens · last ${options.period === "7d" ? "7" : "30"} days`;
    const shortDate = (date: string) => {
      const month = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ][Number(date.slice(5, 7)) - 1];
      return `${month} ${Number(date.slice(8, 10))}`;
    };
    if (style === "stats") {
      const windows = [
        ["Today", data?.highlights?.today],
        ["This week", data?.highlights?.week],
        ["This year", data?.highlights?.year],
      ] as const;
      windows.forEach(([label, value], i) => {
        const x = 26 + i * 177;
        body +=
          text(x, 158, label, 12) +
          text(
            x,
            200,
            value === undefined ? "—" : formatEmbedTokens(value),
            30,
            i === 0 ? color : fg,
            'font-weight="600" letter-spacing="-1"',
          ) +
          text(x, 222, "tokens burned", 10);
      });
      body += text(26, 259, "Calendar totals · your timezone", 9);
    } else if (style === "heatmap") {
      const activity = data?.activity ?? [];
      body += text(26, 136, "Daily activity · last 12 weeks", 10);
      const peak = Math.max(1, ...activity.map((d) => d.tokens));
      const offset = activity.length
        ? (new Date(`${activity[0].date}T00:00:00Z`).getUTCDay() + 6) % 7
        : 0;
      ["M", "", "W", "", "F", "", "S"].forEach((d, i) => {
        body += text(26, 159 + i * 15, d, 9);
      });
      activity.forEach((d, i) => {
        const index = offset + i;
        const x = 47 + Math.floor(index / 7) * 37,
          y = 148 + (index % 7) * 15;
        body += rect(x, y, 29, 11, panel, 2);
        if (d.tokens > 0)
          body += `<rect x="${x}" y="${y}" width="29" height="11" rx="2" fill="${color}" fill-opacity="${(0.2 + (d.tokens / peak) * 0.8).toFixed(2)}"/>`;
      });
      body +=
        text(
          26,
          267,
          activity.length
            ? shortDate(activity[0].date)
            : "No activity available",
          9,
        ) +
        text(
          534,
          267,
          activity.length ? shortDate(activity[activity.length - 1].date) : "",
          9,
          muted,
          'text-anchor="end"',
        );
      body += text(407, 136, "Less", 9);
      [0, 0.25, 0.55, 1].forEach((opacity, i) => {
        body +=
          rect(435 + i * 15, 127, 11, 10, panel, 2) +
          `<rect x="${435 + i * 15}" y="127" width="11" height="10" rx="2" fill="${color}" fill-opacity="${opacity}"/>`;
      });
      body += text(534, 136, "More", 9, muted, 'text-anchor="end"');
    } else if (style === "breakdown") {
      body += text(26, 138, "Tokens by tool", 10);
      const source = data?.byTool ?? [];
      const groups = source.slice(0, 3).map((d) => ({ ...d }));
      if (source.length > 3)
        groups.push({
          tool: "Other tools",
          tokens: source.slice(3).reduce((n, d) => n + d.tokens, 0),
          costUSD: 0,
        });
      const total = source.reduce((n, d) => n + d.tokens, 0);
      const peak = Math.max(1, ...groups.map((d) => d.tokens));
      groups.forEach((d, i) => {
        const y = 162 + i * (groups.length <= 2 ? 44 : 30);
        const tool =
          d.tool === "claude-code" || d.tool === "claude"
            ? "Claude Code"
            : d.tool === "codex"
              ? "Codex"
              : d.tool;
        body +=
          text(26, y + 3, tool.slice(0, 19), 11, fg) +
          rect(157, y - 8, 250, 12, panel, 3) +
          rect(
            157,
            y - 8,
            Math.max(0, (d.tokens / peak) * 250),
            12,
            i === 0 ? color : muted,
            3,
          ) +
          text(
            534,
            y + 3,
            `${formatEmbedTokens(d.tokens)} · ${total ? Math.round((d.tokens / total) * 100) : 0}%`,
            10,
            muted,
            'text-anchor="end"',
          );
      });
      if (!groups.length)
        body += text(
          26,
          192,
          data
            ? "Tool breakdown appears after your first sync."
            : "No public usage available.",
          12,
        );
    } else {
      const top = 157,
        bottom = 244,
        left = 26,
        width = 508;
      body +=
        text(26, 136, chartLabel, 10) +
        text(
          534,
          136,
          data
            ? `${formatEmbedTokens(max === 1 && !days.some((d) => d.tokens) ? 0 : max)} peak`
            : "",
          10,
          muted,
          'text-anchor="end"',
        );
      body += `<path d="M26 ${top}H534 M26 ${Math.round((top + bottom) / 2)}H534 M26 ${bottom}H534" stroke="${line}" stroke-dasharray="3 5"/>`;
      if (style === "signature" && days.length > 1) {
        const points = days.map(
          (d, i) =>
            `${left + (i * width) / (days.length - 1)},${bottom - (Math.max(0, d.tokens) / max) * (bottom - top)}`,
        );
        body += `<path d="M${left},${bottom} L${points.join(" L")} L534,${bottom} Z" fill="${color}" fill-opacity=".1"/><path d="M${points.join(" L")}" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
      } else {
        const step = width / Math.max(days.length, 1);
        days.forEach((d, i) => {
          const bh = Math.max(
            2,
            (Math.max(0, d.tokens) / max) * (bottom - top),
          );
          body += rect(
            left + i * step,
            bottom - bh,
            Math.max(2, step - 4),
            bh,
            d.tokens > 0 ? color : line,
            2,
          );
        });
      }
      if (days.length)
        body +=
          text(26, 264, shortDate(days[0].date), 9) +
          text(
            534,
            264,
            shortDate(days[days.length - 1].date),
            9,
            muted,
            'text-anchor="end"',
          );
    }
    body +=
      text(26, 284, "npx whoburnedmore", 9, muted, 'font-family="monospace"') +
      text(26, 300, status, 9) +
      text(
        534,
        300,
        "whoburnedmore.com ↗",
        11,
        color,
        'text-anchor="end" font-weight="600"',
      );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none" role="img" aria-label="${xml(`${handle}: ${headline}; ${periodLabel(options.period)}; ${status}`)}"><title>${xml(`${handle} · ${headline}`)}</title><g font-family="Arial, Helvetica, sans-serif">${body}</g><rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="${style === "badge" ? 6 : 16}" stroke="${line}"/></svg>`;
}

export function embedMarkdown(
  origin: string,
  handle: string,
  options: EmbedOptions,
): string {
  return `[![${handle}'s AI token usage](${origin}/api/embeds/${encodeURIComponent(handle)}?${embedQuery(options)})](${origin}/u/${encodeURIComponent(handle)}?utm_source=github&utm_medium=profile&utm_campaign=usage-card)`;
}
export function embedAgentPrompt(
  origin: string,
  handle: string,
  options: EmbedOptions,
): string {
  return `Add my whoburnedmore usage card to my GitHub profile README. My whoburnedmore handle is ${handle} (it may differ from my GitHub username).\n\nIdentify my GitHub username from the authenticated GitHub account, then locate its public username/username profile repository and root README.md. If it does not exist, ask before creating a public repository. Do not change the visibility of an existing repository. Preserve all existing content. Insert or update exactly one section between <!-- whoburnedmore:start --> and <!-- whoburnedmore:end --> using this Markdown:\n\n${embedMarkdown(origin, handle, options)}\n\nDo not install a GitHub Action or commit API keys. The hosted image updates from my synced public usage. Show me the README diff and follow the repository's normal review workflow before publishing. Setup and freshness details: ${origin}/embed`;
}
