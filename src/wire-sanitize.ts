import { createHash } from "node:crypto";
import {
  AgentStat as AgentStatSchema,
  BlockEntry as BlockEntrySchema,
  CodexReplayPriorScope as CodexReplayPriorScopeSchema,
  DailyUsageEntry as DailyUsageEntrySchema,
  MAX_USD_PER_MTOK,
  SessionEntry as SessionEntrySchema,
  SkillStat as SkillStatSchema,
  ToolStat as ToolStatSchema,
  type AgentStat,
  type BlockEntry,
  type CodexReplayPriorScope,
  type DailyUsageEntry,
  type SessionEntry,
  type SkillStat,
  type ToolStat,
} from "./shared.js";

// Provider metadata is local-untrusted data. Conventional machine identifiers
// are useful product dimensions; content-shaped strings (spaces, control chars,
// oversized values) are replaced with stable local hashes so neither content nor
// one malformed row can cross the aggregate-only cloud boundary.
const MACHINE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]*$/;

export function sanitizeMachineLabel(
  value: unknown,
  kind: "agent" | "model" | "tool" | "skill",
  maxLength: number,
): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw.length > 0 && raw.length <= maxLength && MACHINE_IDENTIFIER.test(raw)) {
    return raw;
  }
  const digest = createHash("sha256")
    .update(`${kind}\0`)
    .update(raw)
    .digest("hex")
    .slice(0, 12);
  return `${kind}-${digest}`;
}

/** Non-negative finite number, else 0 (cost/token arithmetic only). */
function finiteNonNeg(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Keep one row's cost inside the server's per-row plausibility checks. The API
 * rejects the WHOLE upload — every agent, every day — when any single row has
 * a cost but no tokens, or costs more than $200 per million tokens. Vendor-
 * recorded charges (Cursor, Cline, tokscale, opencode/OpenRouter per-request
 * fees) can legitimately land there, so clamp instead of letting one row sink
 * the sync. Returns null for a cost-only row (no tokens at all): it cannot be
 * represented on the wire.
 */
export function boundRowCost(row: Record<string, unknown>): Record<string, unknown> | null {
  const tokens =
    finiteNonNeg(row.inputTokens) +
    finiteNonNeg(row.outputTokens) +
    finiteNonNeg(row.cacheCreationTokens) +
    finiteNonNeg(row.cacheReadTokens);
  if (tokens === 0) return null;
  const cost = finiteNonNeg(row.costUSD);
  // 1% under the line so float rounding on either side can never cross it.
  const ceiling = (tokens * MAX_USD_PER_MTOK * 0.99) / 1_000_000;
  const bounded = cost > ceiling ? Number(ceiling.toFixed(6)) : cost;
  const out: Record<string, unknown> = { ...row, costUSD: bounded };
  if (row.cacheCreation1hTokens !== undefined) {
    const oneHour = Math.round(finiteNonNeg(row.cacheCreation1hTokens));
    const writes = Math.round(finiteNonNeg(row.cacheCreationTokens));
    if (oneHour > 0) out.cacheCreation1hTokens = Math.min(oneHour, writes);
    else delete out.cacheCreation1hTokens;
  }
  return out;
}

export function sanitizeDailyEntries(rows: readonly unknown[]): DailyUsageEntry[] {
  const safe: DailyUsageEntry[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = boundRowCost(raw as Record<string, unknown>);
    if (!row) continue;
    const parsed = DailyUsageEntrySchema.safeParse({
      ...row,
      tool: sanitizeMachineLabel(row.tool, "agent", 64),
      model: sanitizeMachineLabel(row.model, "model", 128),
      // Only a server-side connector may assert stronger provenance.
      origin: "cli",
      verified: false,
    });
    if (parsed.success) safe.push(parsed.data);
  }
  return safe;
}

export function sanitizeSessions(rows: readonly unknown[]): SessionEntry[] {
  const safe: SessionEntry[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    // Session ids stay on-device today. Hash anyway so a future caller cannot
    // accidentally turn a path-like provider id into hosted metadata.
    const sessionId = createHash("sha256")
      .update("session\0")
      .update(String(row.sessionId ?? ""))
      .digest("hex");
    const parsed = SessionEntrySchema.safeParse({
      ...row,
      sessionId: `local-${sessionId.slice(0, 24)}`,
      tool: sanitizeMachineLabel(row.tool, "agent", 64),
      model: sanitizeMachineLabel(row.model, "model", 128),
    });
    if (parsed.success) safe.push(parsed.data);
  }
  return safe;
}

export function sanitizeBlocks(rows: readonly unknown[]): BlockEntry[] {
  return rows.flatMap((row) => {
    const parsed = BlockEntrySchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export function sanitizeToolStats(rows: readonly unknown[]): ToolStat[] {
  return rows.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const parsed = ToolStatSchema.safeParse({
      ...row,
      name: sanitizeMachineLabel(row.name, "tool", 128),
    });
    return parsed.success ? [parsed.data] : [];
  });
}

export function sanitizeSkillStats(rows: readonly unknown[]): SkillStat[] {
  return rows.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const parsed = SkillStatSchema.safeParse({
      ...row,
      name: sanitizeMachineLabel(row.name, "skill", 128),
    });
    return parsed.success ? [parsed.data] : [];
  });
}

const EMPTY_AGENT: AgentStat = {
  messageCount: 0,
  subagentMessages: 0,
  subagentTokens: 0,
  totalTokens: 0,
  userMessageCount: 0,
};

export function sanitizeAgentStat(value: unknown): AgentStat {
  const parsed = AgentStatSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...EMPTY_AGENT };
}

export function sanitizeCodexReplayScopes(
  scopes: readonly unknown[],
): CodexReplayPriorScope[] {
  return scopes.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const scope = raw as Record<string, unknown>;
    const rows = Array.isArray(scope.rows)
      ? scope.rows.map((row) => {
          if (!row || typeof row !== "object") return row;
          const value = row as Record<string, unknown>;
          return {
            ...value,
            model: sanitizeMachineLabel(value.model, "model", 128),
          };
        })
      : scope.rows;
    const parsed = CodexReplayPriorScopeSchema.safeParse({ ...scope, rows });
    return parsed.success ? [parsed.data] : [];
  });
}
