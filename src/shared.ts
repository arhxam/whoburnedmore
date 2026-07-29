import { z } from "zod";
import type { LaunchStatusResponse } from "./launch-gate.js";
import { RESERVED_SUBDOMAINS } from "./tenant.js";
export * from "./launch-gate.js";
export * from "./pricing.js";

/**
 * Calendar date in YYYY-MM-DD, in the SUBMITTING MACHINE'S LOCAL timezone —
 * not UTC. Every reader (native claude/codex, ccusage, cursor) buckets by
 * local day, `SubmitPayload.tzOffsetMinutes` carries the zone, and the
 * leaderboard's day windows assume it.
 */
export const DateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const tokenCount = z.number().int().nonnegative();

/** Provider/gateway sources a user can connect a read-only key for. */
export const ConnectorProvider = z.enum([
  "anthropic-api",
  "openai-api",
  "openrouter",
  "google-api",
  "cursor",
  "azure-foundry",
]);
export type ConnectorProvider = z.infer<typeof ConnectorProvider>;

/** Where a usage entry came from. "cli" is the local-log default. */
export const UsageOrigin = z.enum([
  "cli",
  "anthropic-api",
  "openai-api",
  "openrouter",
  "google-api",
  "cursor",
  "azure-foundry",
  "import",
]);
export type UsageOrigin = z.infer<typeof UsageOrigin>;

/**
 * One day of usage for one (tool, model) pair. This is the ONLY shape of
 * usage data that ever leaves a user's machine — aggregates, never content.
 */
export const DailyUsageEntry = z.object({
  date: DateString,
  /** Source agent id, e.g. "claude", "codex", "gemini", "copilot". */
  tool: z.string().min(1).max(64),
  /** Model id as reported by the agent, e.g. "claude-sonnet-4-6". */
  model: z.string().min(1).max(128),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheCreationTokens: tokenCount,
  cacheReadTokens: tokenCount,
  /** Estimated cost in USD for this entry. */
  costUSD: z.number().nonnegative(),
  /** Where this entry came from. Defaults to the local CLI for back-compat. */
  origin: UsageOrigin.default("cli"),
  /** True when the numbers come from a provider's authoritative usage API. */
  verified: z.boolean().default(false),
  /**
   * Structural fingerprint: the number of DISTINCT provider requests
   * (unique message-id + request-id pairs) that summed into this entry. A real
   * heavy day is the product of thousands of distinct API requests; a hand-typed
   * fabrication has none. The server uses this as an anti-fraud signal — a
   * billion-token day backed by ~zero real requests is the forgery signature.
   * Optional + back-compat: older CLIs and the ccusage fallback path (which
   * cannot see request ids) omit it, and an omitted fingerprint is never
   * penalized.
   */
  requestCount: z.number().int().nonnegative().optional(),
});
export type DailyUsageEntry = z.infer<typeof DailyUsageEntry>;

/** ISO-8601 timestamp string. */
const Timestamp = z.string().min(1).max(40);

/**
 * One AI coding session (conversation), from `ccusage session`. Aggregate only:
 * a session id, the tool/model, token + cost totals, and last activity time.
 * Never any conversation content.
 */
export const SessionEntry = z.object({
  sessionId: z.string().min(1).max(128),
  tool: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheCreationTokens: tokenCount,
  cacheReadTokens: tokenCount,
  costUSD: z.number().nonnegative(),
  lastActivity: Timestamp,
  /** Number of assistant messages in this session (from transcripts). Optional. */
  messageCount: z.number().int().nonnegative().optional(),
});
export type SessionEntry = z.infer<typeof SessionEntry>;

/**
 * One usage time-window, from `ccusage blocks` — used for hour-of-day ("peak
 * hours") analysis. Just a start time and its token + cost totals.
 */
export const BlockEntry = z.object({
  startTime: Timestamp,
  totalTokens: tokenCount,
  costUSD: z.number().nonnegative(),
});
export type BlockEntry = z.infer<typeof BlockEntry>;

/**
 * One tool's call frequency, parsed from local agent transcripts (e.g. Claude
 * Code `tool_use` names). MCP tools keep their `mcp__server__tool` name. Just a
 * name and a count — never any arguments or content.
 */
export const ToolStat = z.object({
  name: z.string().min(1).max(128),
  count: z.number().int().nonnegative(),
  /** How many of those calls returned an error/interrupt (tool reliability). Optional. */
  errors: z.number().int().nonnegative().optional(),
  /** Tokens burned on turns that used this tool (turn tokens split across its tool calls). Optional. */
  tokens: z.number().int().nonnegative().optional(),
});
export type ToolStat = z.infer<typeof ToolStat>;

/**
 * Subagent-vs-main rollup parsed from local transcripts: how much of the work
 * (messages + tokens) ran inside subagent sidechains. Counts only, no content.
 */
export const AgentStat = z.object({
  /** Total assistant messages across transcripts. */
  messageCount: z.number().int().nonnegative(),
  /** Assistant messages that ran inside a subagent sidechain. */
  subagentMessages: z.number().int().nonnegative(),
  /** Tokens spent inside subagent sidechains. */
  subagentTokens: z.number().int().nonnegative(),
  /** Total tokens observed across transcripts (denominator for the share). */
  totalTokens: z.number().int().nonnegative(),
  /**
   * Messages the human actually sent (their prompts) — non-sidechain user turns
   * carrying real text, NOT tool results or injected/meta turns. Denominator for
   * "avg cost per message". Optional (back-compat with older CLIs).
   */
  userMessageCount: z.number().int().nonnegative().optional(),
});
export type AgentStat = z.infer<typeof AgentStat>;

/** One skill's usage frequency (records produced while the skill was active). */
export const SkillStat = z.object({
  name: z.string().min(1).max(128),
  count: z.number().int().nonnegative(),
  /** Tokens burned in records produced while this skill was active. Optional. */
  tokens: z.number().int().nonnegative().optional(),
});
export type SkillStat = z.infer<typeof SkillStat>;

export const SubmitPayload = z.object({
  cliVersion: z.string().min(1).max(32),
  entries: z.array(DailyUsageEntry).min(1).max(20000),
  /** Optional per-conversation rollups (ccusage session). Back-compat: omittable. */
  sessions: z.array(SessionEntry).max(10000).optional(),
  /** Optional time-window rollups (ccusage blocks) for peak-hours analysis. */
  blocks: z.array(BlockEntry).max(10000).optional(),
  /** Optional tool-call frequencies parsed from local transcripts (names + counts). */
  tools: z.array(ToolStat).max(300).optional(),
  /** Optional skill-usage frequencies parsed from local transcripts. */
  skills: z.array(SkillStat).max(300).optional(),
  /** Optional subagent-vs-main rollup parsed from local transcripts. */
  agent: AgentStat.optional(),
  /**
   * Set when the transcript scan completed within its time budget, i.e. the
   * tool/skill/agent rollups are a FULL snapshot. The server refreshes the
   * dashboard breakdowns unconditionally for a full snapshot; for a partial one
   * (flag absent/false) it keeps its no-shrink guard. Back-compat: omittable.
   */
  attributionComplete: z.boolean().optional(),
  /** Optional friends-board code (from `--board=<code>`): auto-join this board on submit. */
  board: z.string().min(1).max(32).optional(),
  /** Optional organization slug (from `--org=<slug>`): auto-join this org on submit. */
  org: z.string().min(2).max(32).optional(),
  /**
   * Optional org join password (from `--pass=<code>` / `--code=<code>`): required
   * to attach a CLI run to an `org`. Back-compat: omittable — a run with no org
   * never needs it, and a wrong/missing code only skips the org attach (the
   * personal submit still succeeds).
   */
  orgCode: z.string().min(1).max(64).optional(),
  /**
   * The submitter's local UTC offset in minutes EAST of UTC (IST = +330,
   * US-Pacific DST = -420; i.e. `-new Date().getTimezoneOffset()`). ccusage dates
   * usage in this local zone, so the server uses the offset to compute each
   * member's daily/weekly leaderboard window in THEIR calendar day rather than a
   * UTC one. Back-compat: omittable — older CLIs don't send it and the board falls
   * back to its default offset. Range clamps to real zones (UTC-14..+14).
   */
  tzOffsetMinutes: z.number().int().min(-840).max(840).optional(),
});
export type SubmitPayload = z.infer<typeof SubmitPayload>;

/**
 * Anonymous submit: the same usage payload plus a client-held secret key that
 * owns the resulting unlisted dashboard. No sign-in involved.
 */
export const AnonSubmitPayload = SubmitPayload.extend({
  /** Client-generated secret (hex). The server stores only its hash. */
  anonKey: z.string().min(16).max(128),
});
export type AnonSubmitPayload = z.infer<typeof AnonSubmitPayload>;

/**
 * VERIFY — the per-request forensic skeleton a DELISTED user uploads via
 * `whoburnedmore verify` to prove their usage is real. Where SubmitPayload is
 * aggregate daily totals, this carries one record per DEDUPED provider request so
 * the server can independently check internal consistency, physical-throughput
 * plausibility, request-count realism and timing for a contested account. It still
 * carries NO conversation content — only token counts, a timestamp, the model, and
 * a HASHED provider id. Sent only on the explicit, opt-in `verify` command.
 */
export const VerifyRequestRecord = z.object({
  /** Local calendar date (YYYY-MM-DD) this request is bucketed under. */
  date: DateString,
  /** Epoch milliseconds of the request's final (max-token) transcript line. */
  ts: z.number().int().nonnegative(),
  tool: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheCreationTokens: tokenCount,
  cacheReadTokens: tokenCount,
  /** sha256(msgId|reqId), truncated — preserves uniqueness without revealing the id. */
  reqHash: z.string().min(1).max(64),
});
export type VerifyRequestRecord = z.infer<typeof VerifyRequestRecord>;

export const VerifyPayload = z.object({
  cliVersion: z.string().min(1).max(32),
  /** The per-request skeleton (bounded/sampled — see `truncated`). */
  requests: z.array(VerifyRequestRecord).min(1).max(100000),
  /**
   * True when the local corpus exceeded the client upload cap and was sampled to
   * the most recent N requests. The server treats a truncated upload conservatively
   * (it never AUTO-passes a truncated one — it can still auto-FAIL on a physical
   * impossibility, or route to a human).
   */
  truncated: z.boolean().optional(),
});
export type VerifyPayload = z.infer<typeof VerifyPayload>;

/** One named forensic check the analyzer ran, with its result. */
export interface VerifyCheck {
  key: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResponse {
  ok: boolean;
  /** "pass" → relisted; "fail" → stays delisted; "review" → routed to an operator. */
  verdict: "pass" | "fail" | "review";
  /** 0..100 forensic confidence the usage is genuine (advisory; for the operator). */
  score: number;
  /** True when this call cleared the account's suppression. */
  relisted: boolean;
  checks: VerifyCheck[];
  message: string;
}

export function entryTotalTokens(e: DailyUsageEntry): number {
  return (
    e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens
  );
}

export const LeaderboardPeriod = z.enum(["today", "7d", "30d", "all"]);
export type LeaderboardPeriod = z.infer<typeof LeaderboardPeriod>;

export const LeaderboardMetric = z.enum(["tokens", "cost"]);
export type LeaderboardMetric = z.infer<typeof LeaderboardMetric>;

export interface LeaderboardRankMovement {
  /** `up` means the row's current rank number is lower than the previous rank. */
  direction: "up" | "down" | "same" | "new";
  places: number;
  previousRank: number | null;
  /** Snapshot window used for the comparison, in hours. */
  windowHours: number;
  /** Bucket start timestamp of the previous snapshot, or null when none exists. */
  comparedAt: string | null;
}

export interface LeaderboardRow {
  rank: number;
  rankMovement?: LeaderboardRankMovement;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  /** X (Twitter) username without the leading @, or null. */
  xHandle: string | null;
  /** Instagram username without the leading @, when set. Optional (back-compat). */
  instagramHandle?: string | null;
  /** GitHub username, when set. Optional (back-compat). */
  githubHandle?: string | null;
  /** Which connected social to show next to this row on the leaderboard. */
  leaderboardSocial?: "auto" | "x" | "instagram" | "github";
  /** True once a signed-in user owns this row; false for anonymous dashboards. */
  claimed: boolean;
  /**
   * True when this account holds at least one PROVIDER-VERIFIED usage row — i.e.
   * numbers pulled server-side from a provider's authoritative usage API via a
   * connector, not self-reported by the CLI. The trust tier: a verified row is
   * the only kind that cannot be forged. Optional (back-compat). Shown as a badge.
   */
  verified?: boolean;
  totalTokens: number;
  totalCostUSD: number;
  todayTokens: number;
  streakDays: number;
  topTool: string | null;
  topModel: string | null;
  /** Last 7 days of token totals, oldest first, for sparklines. */
  spark7d: number[];
  lastSubmittedAt: string | null;
  /**
   * When this member's token total last actually grew — distinct from
   * lastSubmittedAt (last sync, bumped by every 15-minute heartbeat). Drives the
   * "coding" vs "last coded" status. Optional/null for back-compat and for
   * accounts that haven't had a token-increasing submit yet.
   */
  lastCodedAt?: string | null;
}

export interface LeaderboardResponse {
  launch?: LaunchStatusResponse;
  /** True when rows intentionally hide exact public totals during the launch gate. */
  redacted?: boolean;
  period: LeaderboardPeriod;
  metric: LeaderboardMetric;
  tool: string | null;
  /**
   * Custom date-range window (inclusive, YYYY-MM-DD), echoed back when the caller
   * passed `from`/`to` to zoom the board into an arbitrary span instead of the
   * fixed today/7d/all buckets. When set, they override `period` for the window.
   * Optional (back-compat) — absent for the standard bucketed views.
   */
  from?: string | null;
  to?: string | null;
  generatedAt: string;
  rows: LeaderboardRow[];
}

export interface UserProfileResponse {
  launch?: LaunchStatusResponse;
  /** True when profile detail is intentionally hidden during the launch gate. */
  redacted?: boolean;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  /** X (Twitter) username without the leading @, or null. */
  xHandle: string | null;
  /** Instagram username without the leading @, when set. Optional (back-compat). */
  instagramHandle?: string | null;
  /** GitHub username, when set. Optional (back-compat). */
  githubHandle?: string | null;
  /** Which connected social the owner wants shown on the leaderboard. */
  leaderboardSocial?: "auto" | "x" | "instagram" | "github";
  /** Short free-text bio shown on the profile. Optional (back-compat). */
  bio?: string | null;
  /** Which image avatarUrl points at: a user upload ("custom"), the OAuth image
   *  ("provider"), or none ("default"). Lets the owner UI offer "remove photo"
   *  only for a custom upload. Optional (back-compat). */
  avatarSource?: "custom" | "provider" | "default";
  /** True for a signed-in (claimed) account; false for an anonymous dashboard. */
  claimed: boolean;
  /** Whether this dashboard is currently listed on the public leaderboard. */
  listed: boolean;
  /** True when the account is suppressed for obvious fabrication (anti-cheat) —
   *  hidden from every public surface regardless of `listed`. Optional
   *  (back-compat); only ever set server-side. */
  suppressed?: boolean;
  /** Whether the profile page shows full detail to everyone (true) or only a
   *  minimal private card to non-owners (false). Always present. */
  profilePublic: boolean;
  /** Public org memberships, shown as cross-link badges to /o/<slug>. Optional
   *  (back-compat with older API responses). */
  orgs?: OrgSummary[];
  createdAt: string;
  /** All-time leaderboard rank among listed users (null for anonymous/unranked). */
  rank: number | null;
  /** Rank among listed users restricted to today's burn. Optional (back-compat). */
  dailyRank?: number | null;
  /** Rank among listed users over the last 7 days. Optional (back-compat). */
  weeklyRank?: number | null;
  /** All-time rank (same value as `rank`); explicit alias. Optional (back-compat). */
  allTimeRank?: number | null;
  totals: {
    tokens: number;
    costUSD: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    days: number;
    streakDays: number;
    /** Longest run of consecutive active days, ever. Optional (back-compat). */
    longestStreakDays?: number;
  };
  daily: Array<{
    date: string;
    tokens: number;
    costUSD: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  }>;
  byTool: Array<{ tool: string; tokens: number; costUSD: number }>;
  byModel: Array<{ model: string; tokens: number; costUSD: number }>;
  /**
   * Prompt-cache efficiency: hit-rate (cache reads / reads+input) and the USD
   * saved by reads being cheaper than fresh input. Optional (back-compat).
   */
  cache?: {
    hitRate: number;
    savingsUSD: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  /** Spend pace: today so far, projected day-end, and rolling daily averages. Optional. */
  pace?: {
    todayTokens: number;
    todayCostUSD: number;
    projectedTodayCostUSD: number;
    avgDailyCostUSD: number;
    avgDailyTokens: number;
  };
  /** Subagent-vs-main rollup. `subagentShare` is the token fraction (0..1). Optional. */
  agent?: {
    messageCount: number;
    subagentMessages: number;
    subagentTokens: number;
    totalTokens: number;
    subagentShare: number;
    /** Human-sent message count (their prompts). Optional (back-compat). */
    userMessageCount?: number;
  };
  /** Total assistant messages across transcripts. Optional (back-compat). */
  messageCount?: number;
  /** Tool-call frequencies (built-in + MCP), highest first. Empty until the CLI submits them. */
  tools: ToolStat[];
  /** Skill-usage frequencies, highest first. Empty until the CLI submits them. */
  skills: SkillStat[];
  /** Most expensive conversations, highest cost first (capped). */
  topSessions: Array<{
    sessionId: string;
    tool: string;
    model: string;
    tokens: number;
    costUSD: number;
    lastActivity: string;
    /** Assistant message count for this session, when known. Optional. */
    messageCount?: number | null;
  }>;
  /** Token + cost by hour of today's UTC day, always length 24 (index = hour). */
  hourly: Array<{ hour: number; tokens: number; costUSD: number }>;
  /**
   * Recent aggregate usage blocks. The web dashboard re-buckets these in the
   * viewer's browser timezone so "hourly burn today" follows local time.
   * Optional for back-compat with older API responses.
   */
  hourlyBlocks?: Array<{ startTime: string; tokens: number; costUSD: number }>;
  /** Raw day-level rows (date × tool × model) for the personal data table. */
  entries: Array<{
    date: string;
    tool: string;
    model: string;
    tokens: number;
    costUSD: number;
  }>;
  lastSubmittedAt: string | null;
  /**
   * When this account's token total last grew (its most recent real coding
   * session), as opposed to lastSubmittedAt (last background sync). Powers the
   * profile's "coding · synced Xm ago" / "last coded Xh ago" status line.
   * Optional/null for back-compat and pre-first-code accounts.
   */
  lastCodedAt?: string | null;
}

/** One member shown on a board's roster. */
export interface BoardMember {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  /** True once a signed-in account owns this row; false for an unclaimed CLI run. */
  claimed: boolean;
  /** True if this member is the board's owner. */
  isOwner: boolean;
  /** True when the member ranks on the board's leaderboard (signed in with at
   *  least one social). Absent on old API responses — treat missing as true. */
  listed?: boolean;
}

export interface BoardResponse {
  code: string;
  name: string;
  ownerHandle: string;
  memberCount: number;
  createdAt: string;
  /** Full roster, owner first. Optional (back-compat with the pre-redesign shape). */
  members?: BoardMember[];
  /** Soft-deleted tombstone: 200-cacheable so stale caches can be replaced;
   *  clients treat it as not-found. Absent on live boards. */
  archived?: boolean;
}

/** One board in a signed-in user's "your boards" list. */
export interface BoardSummary {
  code: string;
  name: string;
  memberCount: number;
  /** "owner" if the viewer created it, else "member". */
  role: "owner" | "member";
  createdAt: string;
}

export interface MyBoardsResponse {
  boards: BoardSummary[];
}

/** Returned when a board is created (signed-in `POST /v1/boards`). */
export interface BoardCreateResponse {
  ok: true;
  code: string;
  name: string;
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

export type DeviceTokenResponse =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "ok"; token: string; handle: string };

export interface SubmitResponse {
  ok: true;
  upserted: number;
  totalTokens: number;
  totalCostUSD: number;
  rank: number | null;
  profileUrl: string;
  /**
   * True when the account is currently delisted (suppressed) — either from a
   * prior decision or a signal on THIS submit. Lets the CLI tell the user on a
   * normal run that they're off the board and offer to verify, instead of the
   * delisting being silently invisible on the surface people actually use.
   */
  suppressed?: boolean;
  /**
   * Days whose total cleared the universal approval ceiling on THIS submit and
   * are now held off every public ranking pending an operator's approval. Stored
   * and kept — never dropped. Present only when at least one day was held.
   */
  pendingApproval?: string[];
  /**
   * Days the anomaly two-key rule removed from every public board on THIS submit
   * (a severe self-reported spike an independent signal corroborated). The rows
   * are QUARANTINED, not destroyed — recoverable by an operator or a successful
   * appeal/verify — so the CLI can tell the user exactly which days were pulled
   * and how to contest, instead of the removal being silent. Present only when at
   * least one day was quarantined.
   */
  quarantinedDates?: string[];
  /** Set when a `board` code was supplied and the user joined it. */
  boardCode?: string;
  /** Full URL of the friends board, e.g. https://whoburnedmore.com/boards/<code>. */
  boardUrl?: string;
  /** Set when an `org` slug + valid password was supplied and the user joined it. */
  orgSlug?: string;
  /** Full URL of the org board, e.g. https://whoburnedmore.com/o/<slug>/board. */
  orgBoardUrl?: string;
}

export interface AnonSubmitResponse {
  ok: true;
  launch?: LaunchStatusResponse;
  upserted: number;
  totalTokens: number;
  totalCostUSD: number;
  /** Public, unguessable slug for the shareable dashboard URL. */
  slug: string;
  /** Full URL of the shareable dashboard, e.g. https://whoburnedmore.com/d/<slug>. */
  dashboardUrl: string;
  /** Set when a `board` code was supplied and the anon user joined it. */
  boardCode?: string;
  /** Full URL of the friends board, e.g. https://whoburnedmore.com/boards/<code>. */
  boardUrl?: string;
  /** Set when an `org` slug + valid password was supplied and the user joined it. */
  orgSlug?: string;
  /** Full URL of the org board the CLI should funnel the runner to. */
  orgBoardUrl?: string;
}

export interface ApiError {
  error: string;
  details?: string[];
}

/** One connected provider/gateway source, as shown in the profile manager. */
export interface ConnectorSummary {
  provider: ConnectorProvider;
  /** Masked key for display, e.g. "sk-…a1b2". Never the full key. */
  keyHint: string;
  status: "ok" | "error" | "pending";
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface ConnectorListResponse {
  connectors: ConnectorSummary[];
}

/* ────────────────────────────────────────────────────────────────────────────
 * Organizations (whoburnedmore for Teams)
 *
 * An Organization is a multi-tenant boundary on top of the existing global
 * leaderboard: companies / hackathons / hackerhouses get a subdomain board, a
 * branded public page, member management, and org-scoped CLI submission. It is
 * SEPARATE from friends Boards; members are normal users joined into the org.
 * ──────────────────────────────────────────────────────────────────────────── */

export const OrgType = z.enum(["company", "hackathon", "hackerhouse"]);
export type OrgType = z.infer<typeof OrgType>;

/** Roles within an organization, most-privileged first. */
export const MemberRole = z.enum(["owner", "admin", "member"]);
export type MemberRole = z.infer<typeof MemberRole>;

/** Who can view an org's internal board. */
export const OrgBoardVisibility = z.enum(["public", "members"]);
export type OrgBoardVisibility = z.infer<typeof OrgBoardVisibility>;

/** Accent color as a 3- or 6-digit hex (with leading #). */
export const HexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "must be a hex color like #f97316");

/**
 * Slugs that may NOT be used for an org — they collide with reserved subdomains
 * or top-level product routes. Kept in sync with RESERVED_SUBDOMAINS plus the
 * app's own first-path segments.
 */
export const RESERVED_SLUGS = new Set<string>([
  ...RESERVED_SUBDOMAINS,
  "o",
  "d",
  "u",
  "boards",
  "board",
  "claim",
  "signin",
  "signout",
  "login",
  "logout",
  "dashboard",
  "install",
  "for-teams",
  "teams",
  "about",
  "contact",
  "trust",
  "cli",
  "feedback",
  "guides",
  "guide",
  "join",
  "leaderboard",
  "settings",
  "account",
  "me",
  "new",
  "robots",
  "sitemap",
]);

/**
 * Word-boundary matched abuse/slur tokens disallowed in org slugs and names.
 * Matched on a normalized copy (lowercased, leetspeak folded, non-letters
 * stripped, split on non-alphanumerics) so "f4ggot" is caught while innocent
 * substrings are NOT — a match requires the token to stand as a whole normalized
 * run (so "Scunthorpe" / "assassin" pass). Intentionally small: blocks the
 * obvious cases, not an exhaustive filter.
 */
const ORG_TEXT_BLOCKLIST = new Set<string>([
  "nigger",
  "nigga",
  "faggot",
  "retard",
  "rape",
  "rapist",
  "kike",
  "spic",
  "chink",
  "cunt",
]);
const ORG_TEXT_LEET: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "@": "a",
  "$": "s",
};

/** True when `input` contains no blocklisted slur/abuse token (see ORG_TEXT_BLOCKLIST). */
export function isCleanOrgText(input: string): boolean {
  const runs = String(input)
    .toLowerCase()
    .split(/[^a-z0-9@$]+/)
    .map((run) =>
      run.replace(/[0-9@$]/g, (c) => ORG_TEXT_LEET[c] ?? c).replace(/[^a-z]/g, ""),
    );
  return !runs.some((run) => run.length > 0 && ORG_TEXT_BLOCKLIST.has(run));
}

/** All org lifecycle states. `suspended` = admin-hidden but retained (reversible);
 *  `archived` = soft-deleted. */
export type OrgStatus = "active" | "suspended" | "archived";

/** Org slug rules: 2–32 chars, lowercase alphanumeric + single internal hyphens. */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

export function isValidSlug(slug: string): boolean {
  return (
    typeof slug === "string" &&
    slug.length >= 2 &&
    slug.length <= 32 &&
    SLUG_RE.test(slug) &&
    // Reject consecutive hyphens — the regex above permits "a--b", which makes
    // for confusing subdomains and is never a deliberate slug.
    !slug.includes("--") &&
    !RESERVED_SLUGS.has(slug)
  );
}

export const OrgSlug = z
  .string()
  .min(2)
  .max(32)
  .refine(isValidSlug, "invalid or reserved slug")
  .refine(isCleanOrgText, "invalid or reserved slug");

/** Optional event window (inclusive YYYY-MM-DD). Used to time-box a hackathon. */
export const OrgWindow = z
  .object({
    startDate: DateString.nullable().optional(),
    endDate: DateString.nullable().optional(),
  })
  // A reversed window (end before start) would silently render an empty board.
  // YYYY-MM-DD strings are lexicographically ordered, so a string compare is safe.
  .refine(
    (w) => !(w.startDate && w.endDate) || w.endDate >= w.startDate,
    { message: "endDate must be on or after startDate", path: ["endDate"] },
  );
export type OrgWindow = z.infer<typeof OrgWindow>;

/** How members may join an org. */
export const OrgJoinPolicy = z.object({
  allowCodeJoin: z.boolean().default(true),
  allowDomainJoin: z.boolean().default(false),
  /** Verified email domains that auto-join, e.g. ["acme.com"]. */
  emailDomains: z.array(z.string().min(3).max(253).toLowerCase()).max(20).default([]),
});
export type OrgJoinPolicy = z.infer<typeof OrgJoinPolicy>;

/** Public application form submitted at /for-teams. */
export const OrgApplicationInput = z.object({
  type: OrgType,
  orgName: z.string().min(1).max(120),
  desiredSlug: z.string().min(2).max(32).optional(),
  contactName: z.string().min(1).max(120),
  contactEmail: z.string().email().max(254),
  website: z.string().url().max(300).optional(),
  /** Rough headcount / attendee estimate, free text. */
  size: z.string().max(60).optional(),
  message: z.string().max(2000).optional(),
});
export type OrgApplicationInput = z.infer<typeof OrgApplicationInput>;

/** Admin provisioning input (creates the live Organization). */
export const OrgProvisionInput = z.object({
  /** When provisioning straight from an application. */
  applicationId: z.string().min(1).max(64).optional(),
  slug: OrgSlug,
  name: z.string().min(1).max(120),
  type: OrgType,
  /** Handle (or email) of the user who becomes Owner. */
  ownerHandle: z.string().min(1).max(120).optional(),
  ownerEmail: z.string().email().max(254).optional(),
  description: z.string().max(2000).optional(),
  boardVisibility: OrgBoardVisibility.optional(),
  window: OrgWindow.optional(),
  /** Brand accent applied to the org homepage theming. */
  accentColor: HexColor.optional(),
  /**
   * Create the org UNOWNED and mint a one-time owner-claim ("admin sign-in")
   * token in the same call. The first person to open the link + sign in becomes
   * the owner; the token is then consumed. When set, an owner email/handle is
   * NOT required — the link is how the first admin is assigned.
   */
  issueClaimLink: z.boolean().optional(),
});
export type OrgProvisionInput = z.infer<typeof OrgProvisionInput>;

/**
 * Signed-in self-service org creation: the authenticated caller becomes the
 * owner immediately (no approval, no claim link). Slug + name are run through the
 * reserved/abuse filters via OrgSlug and isCleanOrgText.
 */
export const OrgSelfServeInput = z.object({
  slug: OrgSlug,
  name: z.string().min(1).max(120).refine(isCleanOrgText, "name not allowed"),
  type: OrgType,
  description: z.string().max(2000).optional(),
  accentColor: HexColor.optional(),
  /** Who can view the board — defaults to the type's default when omitted. */
  boardVisibility: OrgBoardVisibility.optional(),
  /** Optional event window (mainly for hackathons). */
  window: OrgWindow.optional(),
});
export type OrgSelfServeInput = z.infer<typeof OrgSelfServeInput>;

/** Org admin settings update (PATCH). All fields optional. The logo is NOT
 *  settable here — it changes only through the upload endpoints, which
 *  re-encode the image server-side and store it on first-party storage (a raw
 *  URL field would let an admin point the org mark at an arbitrary host). */
export const OrgSettingsInput = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  accentColor: HexColor.optional(),
  boardVisibility: OrgBoardVisibility.optional(),
  window: OrgWindow.optional(),
  joinPolicy: OrgJoinPolicy.partial().optional(),
});
export type OrgSettingsInput = z.infer<typeof OrgSettingsInput>;

/** Member join input (subdomain/web). */
export const OrgJoinInput = z.object({
  /** Required only when joining via a code; domain/admin joins omit it. */
  code: z.string().min(1).max(64).optional(),
});
export type OrgJoinInput = z.infer<typeof OrgJoinInput>;

/**
 * Provisioning defaults keyed by org type. Hackathons are time-boxed + public;
 * companies lean private; hackerhouses are ongoing + public. All overridable.
 */
export function defaultsForType(type: OrgType): {
  boardVisibility: OrgBoardVisibility;
  timeBoxed: boolean;
} {
  switch (type) {
    case "company":
      return { boardVisibility: "members", timeBoxed: false };
    case "hackathon":
      return { boardVisibility: "public", timeBoxed: true };
    case "hackerhouse":
      return { boardVisibility: "public", timeBoxed: false };
  }
}

/** One member on an org roster. */
export interface OrgMember {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  claimed: boolean;
  role: MemberRole;
}

/** Public org metadata (the /o/<slug> page + subdomain chrome). */
export interface OrgPublic {
  slug: string;
  name: string;
  type: OrgType;
  description: string | null;
  logoUrl: string | null;
  accentColor: string | null;
  boardVisibility: OrgBoardVisibility;
  allowCodeJoin?: boolean;
  allowDomainJoin?: boolean;
  /**
   * Auto-join email domains. For a members-only (private) board this is
   * manager-only — publishing it would hand outsiders the exact join vector —
   * so non-manager viewers get `[]`.
   */
  emailDomains?: string[];
  /**
   * The org's join password (its `joinCode`) — surfaced publicly so the board's
   * copy-command can show the full `npx whoburnedmore --org <slug> --pass <code>`
   * a new member runs. Intentionally public for frictionless joining; the admin
   * rotates it to revoke. Optional (back-compat with older API responses).
   */
  joinPassword?: string | null;
  memberCount: number;
  /**
   * Aggregate usage across the whole org — the intentionally-public outward
   * number even for private boards. Zeroed (with `aggregatesHidden: true`)
   * for very small private orgs, where the org total would effectively BE one
   * member's personal usage.
   */
  totalTokens: number;
  totalCostUSD: number;
  /**
   * True when the org total is withheld from this viewer (private board with
   * fewer members than the k-anonymity floor, viewer not a member). UIs show
   * a placeholder instead of `0`. Optional (back-compat).
   */
  aggregatesHidden?: boolean;
  window: { startDate: string | null; endDate: string | null };
  createdAt: string;
}

/** Org-scoped leaderboard (reuses LeaderboardRow). */
export interface OrgLeaderboardResponse {
  slug: string;
  name: string;
  period: LeaderboardPeriod;
  metric: LeaderboardMetric;
  from?: string | null;
  to?: string | null;
  generatedAt: string;
  rows: LeaderboardRow[];
}

/** One org in a user's "your organizations" list. */
export interface OrgSummary {
  slug: string;
  name: string;
  type: OrgType;
  logoUrl: string | null;
  role: MemberRole;
  memberCount: number;
}

export interface MyOrgsResponse {
  orgs: OrgSummary[];
}

/** Org admin analytics. */
export interface OrgAnalyticsResponse {
  memberCount: number;
  /** Members who have submitted at least once. */
  activeMemberCount: number;
  /** activeMemberCount / memberCount as a 0..1 fraction. */
  adoptionPct: number;
  totalTokens: number;
  totalCostUSD: number;
  /** Daily token/cost over the trailing 30 days, oldest first. */
  trend30d: Array<{ date: string; tokens: number; costUSD: number }>;
  topTools: Array<{ name: string; tokens: number }>;
  topModels: Array<{ name: string; tokens: number }>;
  topMembers: Array<{ handle: string; displayName: string; tokens: number }>;
}

/** Custom-domain status for an org (Vercel-backed). */
export interface OrgCustomDomain {
  host: string;
  status: "pending" | "verified" | "error";
  /** DNS records the org must add, surfaced from the Vercel API. */
  verification: Array<{ type: string; domain: string; value: string }>;
  lastError?: string | null;
}

export interface OrgApplicationSummary {
  id: string;
  type: OrgType;
  orgName: string;
  desiredSlug: string | null;
  contactName: string;
  contactEmail: string;
  website: string | null;
  size: string | null;
  message: string | null;
  status: "pending" | "approved" | "rejected";
  linkedOrgSlug: string | null;
  createdAt: string;
}

export interface OrgAdminSummary {
  slug: string;
  name: string;
  type: OrgType;
  memberCount: number;
  ownerHandle: string | null;
  /** Email of the owner-to-be when the org is provisioned before they sign in.
   *  Null once an owner has claimed it. Optional (back-compat). */
  pendingOwnerEmail?: string | null;
  boardVisibility: OrgBoardVisibility;
  customDomain: string | null;
  /** Current logo URL (blob/seed/external), or null when the org has none yet.
   *  Lets the admin dashboard flag logo-less orgs + offer an upload. Optional (back-compat). */
  logoUrl?: string | null;
  totalTokens: number;
  createdAt: string;
  /** Subdomain (`<slug>.<root>`) registration status. Optional (back-compat). */
  subdomainStatus?: "pending" | "active" | "error";
  /** Live one-time owner-claim token, or null when no claim link is active.
   *  The dashboard builds `/o/<slug>/claim?t=<token>` from it. Optional (back-compat). */
  claimToken?: string | null;
  /** Org lifecycle status. Optional (back-compat; legacy rows are active). */
  status?: OrgStatus;
  /** How the org was created — surfaces self-serve vs operator provisioning. Optional. */
  createdVia?: "self-serve" | "admin" | "seed" | null;
  /** Owner's handle, echoed for abuse tracing next to createdVia. Optional. */
  createdByHandle?: string | null;
  /** How many non-archived orgs this owner owns — flags cap abuse. Optional. */
  ownerOrgCount?: number;
}

/**
 * Translate an internal anti-cheat reason string (the raw operator/detector text
 * stored in `suppressedReason`/`flagReasons`, e.g. "covered daily total (…) is
 * 45.2x its own cross-tool session rollup …") into ONE plain-English sentence a
 * normal user can act on. The raw strings are engineering diagnostics — useful in
 * the admin queue, confusing and slightly accusatory on a user's own screen.
 *
 * Matching is substring-based on the stable phrases the detectors emit
 * (validation.ts / reconcile.ts / anomaly.ts / history-integrity.ts). Anything
 * unrecognized — or a null/empty reason — falls back to a safe, non-blaming
 * default keyed on the moderation state, so a blank reason never renders as a
 * bare "you were delisted" with no cause. Pure + deterministic (unit-tested).
 */
export function friendlyModerationReason(
  rawReason: string | null | undefined,
  state: { suppressed?: boolean; blocked?: boolean; flagged?: boolean } = {},
): string {
  const r = (rawReason ?? "").toLowerCase();
  const has = (...needles: string[]) => needles.some((n) => r.includes(n));

  if (r) {
    // Cross-rollup / provenance mismatches — the most common suppression.
    if (has("cross-tool session rollup", "its own rollups", "possible inflation"))
      return "Your daily totals didn't line up with your session history from the same runs. Re-sync with the latest CLI or run a verify so we can match them up.";
    if (has("no rollups", "no request fingerprints", "carries no provenance", "no provenance", "must emit provenance"))
      return "This submission didn't carry the usage details we use to confirm it's real. Run a verify from the machine where you actually use your AI tools and you'll be back on.";
    if (has("sustained near-ceiling", "fabricated drip"))
      return "You've logged many very large days but none have carried verifiable usage details yet. One verify (or a sync with the latest CLI) will confirm them.";
    // Volume / anomaly spikes.
    if (has("extreme high-volume", "anomalous spike", "prior peak", "typical day"))
      return "One of your days was far larger than your usual pattern, so it's held off the board until you verify it. If it's real, a verify puts it back.";
    // Economic-floor / round-number / fabricated-cost.
    if (has("cost floor", "fabricated cost", "below any real model"))
      return "The cost reported for your tokens was below what any real model charges, so we couldn't accept it as-is. Re-sync with the latest CLI, which computes cost for you.";
    if (has("round-number", "suspiciously round"))
      return "Your numbers landed on suspiciously round values, which real usage almost never does. A fresh sync or verify will clear it.";
    // History rewrite.
    if (has("history rewrite", "retroactively inflated", "back-dated"))
      return "A past day was re-stated much higher than we'd previously recorded. If that was a legitimate late-arriving sync, verify to confirm it.";
    // Admin/manual action.
    if (has("admin", "manual"))
      return "Your account was reviewed by our team. If you think this is a mistake, tell us below and we'll take another look.";
  }

  // Fallback by state — never a bare, cause-less accusation.
  if (state.blocked)
    return "Your account is blocked, so new usage isn't being accepted. If you think this is a mistake, make your case below and we'll review it.";
  if (state.suppressed)
    return "We couldn't automatically confirm your recent numbers, so you're off the public board for now. The fastest way back is to run a verify from the command line.";
  if (state.flagged)
    return "Your recent numbers are being reviewed. Running a verify now confirms them and keeps you on the board.";
  return "Your account is under review. Run a verify from the command line to confirm your usage.";
}

export { ROOT_DOMAIN, normalizeHost, resolveTenant } from "./tenant.js";
export type { Tenant } from "./tenant.js";
// Re-export the locally-imported set (used by RESERVED_SLUGS above) so it stays
// part of the public API without a star re-export.
export { RESERVED_SUBDOMAINS };
