import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AgentStat, SkillStat, ToolStat } from "./shared.js";
import { NATIVE_READ_BUDGET_MS } from "./native/claude.js";
import { nativeCachePath, readFilesWithCache } from "./native/file-cache.js";

// ccusage gives tokens by tool/model, but not which tools/skills/MCP servers you
// actually invoke, how much runs inside subagents, or how reliable your tools
// are. That all lives in Claude Code's transcripts: each record may have an
// `attributionSkill`, assistant messages carry `tool_use` blocks (name = tool)
// plus a `usage` block (tokens) and an `isSidechain` flag (subagent), and tool
// failures show up as `tool_result` blocks with `is_error`. We count names +
// tokens — never arguments, content, project/repo names, or conversation titles.
// Best-effort and bounded so a huge ~/.claude never makes the CLI hang.

const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");
const CODEX_SESSIONS = join(homedir(), ".codex", "sessions");
const MAX_FILES = 5000;
/**
 * Wall-clock budget for the whole attribution scan. It used to be 12s and re-read
 * the ENTIRE transcript corpus on every run with no cache — so under the launchd
 * `Background` process type (macOS throttles CPU/IO several-fold) it chronically
 * timed out, `attributionComplete` dropped, and a heavy user's agent/tools/skills
 * rollups came back partial run after run. It now reads through the SAME
 * persistent per-file cache the native readers use (see `collectAttribution`),
 * so a steady-state run only parses today's changed files; this budget therefore
 * effectively gates only the cold first pass. Matched to the native readers'
 * value (imported, not re-declared, so the two never drift apart).
 */
export const TIME_BUDGET_MS = NATIVE_READ_BUDGET_MS;
/** Bump when the per-file attribution parse/rollup shape changes — invalidates
 *  the persistent per-file cache (loadCache drops a mismatched version). */
export const ATTRIBUTION_CACHE_VERSION = 1;
const MAX_STATS = 300;

/**
 * Count tool_use names and the attributionSkill on one parsed transcript record.
 * Pure + tested; mutates the provided maps. Unknown shapes are ignored. Kept for
 * back-compat — the richer pass below is what collectAttribution() now uses.
 */
export function countRecord(
  rec: unknown,
  tools: Map<string, number>,
  skills: Map<string, number>,
): void {
  if (!rec || typeof rec !== "object") return;
  const r = rec as {
    message?: { content?: unknown };
    attributionSkill?: unknown;
  };
  const content = r.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_use" &&
        typeof (block as { name?: unknown }).name === "string"
      ) {
        const name = (block as { name: string }).name.slice(0, 128);
        if (name) tools.set(name, (tools.get(name) ?? 0) + 1);
      }
    }
  }
  if (typeof r.attributionSkill === "string" && r.attributionSkill) {
    const s = r.attributionSkill.slice(0, 128);
    skills.set(s, (skills.get(s) ?? 0) + 1);
  }
}

/** Mutable accumulator for one full pass over the transcripts. */
export interface Accumulator {
  tools: Map<string, { count: number; errors: number; tokens: number }>;
  skills: Map<string, { count: number; tokens: number }>;
  agent: {
    messageCount: number;
    subagentMessages: number;
    subagentTokens: number;
    totalTokens: number;
    /** Messages the human actually sent (their prompts). */
    userMessageCount: number;
  };
  /** sessionId -> assistant message count. */
  sessionMessages: Map<string, number>;
}

/** Per-file scratch state (tool_use id -> tool name, for error matching). */
export interface FileContext {
  toolNames: Map<string, string>;
}

export function createAccumulator(): Accumulator {
  return {
    tools: new Map(),
    skills: new Map(),
    agent: {
      messageCount: 0,
      subagentMessages: 0,
      subagentTokens: 0,
      totalTokens: 0,
      userMessageCount: 0,
    },
    sessionMessages: new Map(),
  };
}

export function createFileContext(): FileContext {
  return { toolNames: new Map() };
}

function recordTokens(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown) => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  return (
    n(u.input_tokens) +
    n(u.output_tokens) +
    n(u.cache_creation_input_tokens) +
    n(u.cache_read_input_tokens)
  );
}

/**
 * True when a user record carries an actual human prompt: a non-empty string,
 * or a `text` block with non-empty text — and not an injected system turn
 * (system-reminder / slash-command expansion). tool_result-only turns return
 * false (no text), so they don't count as messages the person sent.
 */
function hasHumanText(content: unknown): boolean {
  const isHuman = (t: string): boolean => {
    const s = t.trim();
    return (
      s.length > 0 &&
      !s.startsWith("<system-reminder") &&
      !s.startsWith("<command-") &&
      !s.startsWith("Caveat:")
    );
  };
  if (typeof content === "string") return isHuman(content);
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) =>
      b !== null &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string" &&
      isHuman((b as { text: string }).text),
  );
}

/**
 * Fold one parsed transcript record into the accumulator. Handles: tool_use
 * names + per-tool error counts (matched by tool_use_id within the file),
 * subagent vs total tokens/messages, per-session message counts, and
 * attributionSkill. Pure aside from the maps it mutates; unknown shapes are
 * ignored. Deliberately ignores `cwd` (repo/project names) and `aiTitle`
 * (conversation titles) — that data is never collected.
 */
export function processRecord(
  rec: unknown,
  acc: Accumulator,
  ctx: FileContext,
): void {
  if (!rec || typeof rec !== "object") return;
  const r = rec as {
    type?: unknown;
    isSidechain?: unknown;
    isMeta?: unknown;
    sessionId?: unknown;
    attributionSkill?: unknown;
    message?: { role?: unknown; content?: unknown; model?: unknown; usage?: unknown };
  };

  const recTokens = recordTokens(r.message?.usage);

  // Count messages the human actually sent: a non-sidechain, non-meta user turn
  // that carries real typed text (string content or a text block) — NOT a
  // tool_result turn (those are role:user too) and NOT a system-reminder/injected
  // turn. This is the denominator for "avg cost per message".
  if (
    (r.type === "user" || r.message?.role === "user") &&
    r.isSidechain !== true &&
    r.isMeta !== true &&
    hasHumanText(r.message?.content)
  ) {
    acc.agent.userMessageCount += 1;
  }

  if (typeof r.attributionSkill === "string" && r.attributionSkill) {
    const s = r.attributionSkill.slice(0, 128);
    const sk = acc.skills.get(s) ?? { count: 0, tokens: 0 };
    sk.count += 1;
    sk.tokens += recTokens;
    acc.skills.set(s, sk);
  }

  const content = r.message?.content;
  if (!Array.isArray(content)) return;

  const isAssistant = r.type === "assistant" || r.message?.role === "assistant";
  const isUser = r.type === "user" || r.message?.role === "user";

  if (isAssistant) {
    // tool_use names + per-tool tokens (the turn's tokens split evenly across
    // its tool calls), plus id->name for error matching.
    const toolUses: Array<{ name: string; id?: string }> = [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_use" &&
        typeof (block as { name?: unknown }).name === "string"
      ) {
        const name = (block as { name: string }).name.slice(0, 128);
        if (!name) continue;
        const id = (block as { id?: unknown }).id;
        toolUses.push({ name, id: typeof id === "string" ? id : undefined });
      }
    }
    const perToolTokens =
      toolUses.length > 0 ? Math.floor(recTokens / toolUses.length) : 0;
    for (const tu of toolUses) {
      const t = acc.tools.get(tu.name) ?? { count: 0, errors: 0, tokens: 0 };
      t.count += 1;
      t.tokens += perToolTokens;
      acc.tools.set(tu.name, t);
      if (tu.id) ctx.toolNames.set(tu.id, tu.name);
    }

    // Per-message tokens → subagent + message-count rollups.
    const tokens = recTokens;
    acc.agent.messageCount += 1;
    acc.agent.totalTokens += tokens;
    const sidechain = r.isSidechain === true;
    if (sidechain) {
      acc.agent.subagentMessages += 1;
      acc.agent.subagentTokens += tokens;
    }
    if (typeof r.sessionId === "string" && r.sessionId) {
      acc.sessionMessages.set(
        r.sessionId,
        (acc.sessionMessages.get(r.sessionId) ?? 0) + 1,
      );
    }
  } else if (isUser) {
    // tool_result errors → bump the matching tool's error count.
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_result" &&
        (block as { is_error?: unknown }).is_error === true
      ) {
        const id = (block as { tool_use_id?: unknown }).tool_use_id;
        const name = typeof id === "string" ? ctx.toolNames.get(id) : undefined;
        if (name) {
          const t = acc.tools.get(name) ?? { count: 0, errors: 0, tokens: 0 };
          t.errors += 1;
          acc.tools.set(name, t);
        }
      }
    }
  }
}

/** Convert the skill map into a sorted, capped {name, count, tokens}[]. */
function toSkillStats(map: Map<string, { count: number; tokens: number }>): SkillStat[] {
  return [...map.entries()]
    .map(([name, v]) => ({ name, count: v.count, tokens: v.tokens }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.tokens - a.tokens || b.count - a.count)
    .slice(0, MAX_STATS)
    .map((s) => (s.tokens > 0 ? s : { name: s.name, count: s.count }));
}

function toToolStats(
  map: Map<string, { count: number; errors: number; tokens: number }>,
): ToolStat[] {
  return [...map.entries()]
    .map(([name, v]) => ({ name, count: v.count, errors: v.errors, tokens: v.tokens }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.tokens - a.tokens || b.count - a.count)
    .slice(0, MAX_STATS)
    // Only attach errors/tokens when nonzero, so legacy-shaped consumers see
    // the same minimal payload.
    .map((s) => {
      const base: ToolStat = { name: s.name, count: s.count };
      if (s.errors > 0) base.errors = s.errors;
      if (s.tokens > 0) base.tokens = s.tokens;
      return base;
    });
}

export interface AttributionResult {
  tools: ToolStat[];
  skills: SkillStat[];
  agent: AgentStat;
  /** sessionId -> assistant message count. */
  sessionMessages: Map<string, number>;
  /**
   * False if transcript scanning hit its time budget (snapshot may be partial,
   * so the server applies its no-shrink guard). True for a full pass — the server
   * then refreshes the breakdowns unconditionally so they never go stale.
   */
  complete: boolean;
}

export function accumulatorToResult(acc: Accumulator): AttributionResult {
  return {
    tools: toToolStats(acc.tools),
    skills: toSkillStats(acc.skills),
    agent: { ...acc.agent },
    sessionMessages: acc.sessionMessages,
    complete: true,
  };
}

function numTok(v: unknown): number {
  const x = Math.round(Number(v));
  return Number.isFinite(x) && x > 0 ? x : 0;
}

/** Per-file scratch state for a Codex rollout transcript. */
export interface CodexContext {
  /** function_calls seen since the last token_count, for the per-tool token split. */
  pending: Array<{ name: string; id?: string }>;
}
export function createCodexContext(): CodexContext {
  return { pending: [] };
}

/**
 * Fold one Codex rollout record into the accumulator. Codex writes a JSONL
 * "rollout" per session: `response_item` payloads of type `function_call` (or
 * `custom_tool_call` / `local_shell_call`) are tool calls (MCP tools keep their
 * server-prefixed name), and `event_msg` payloads of type `token_count` carry
 * the turn's `last_token_usage`. We split that turn's tokens across the tools
 * called in the turn. Codex has no subagent concept, so the subagent counters
 * stay zero. Names + counts only — never content, and never the `cwd`
 * (repo/project name).
 */
export function processCodexRecord(
  rec: unknown,
  acc: Accumulator,
  ctx: CodexContext,
): void {
  if (!rec || typeof rec !== "object") return;
  const r = rec as { type?: unknown; payload?: unknown };
  if (!r.payload || typeof r.payload !== "object") return;
  const pl = r.payload as Record<string, unknown>;
  const ptype = pl.type;

  // session_meta / turn_context carry cwd + model, which we no longer collect.
  if (r.type === "session_meta" || r.type === "turn_context") return;

  if (
    ptype === "function_call" ||
    ptype === "custom_tool_call" ||
    ptype === "local_shell_call"
  ) {
    const raw =
      typeof pl.name === "string"
        ? pl.name
        : ptype === "local_shell_call"
          ? "local_shell"
          : "";
    const name = raw.slice(0, 128);
    if (!name) return;
    const id = typeof pl.call_id === "string" ? pl.call_id : undefined;
    ctx.pending.push({ name, id });
    const t = acc.tools.get(name) ?? { count: 0, errors: 0, tokens: 0 };
    t.count += 1;
    acc.tools.set(name, t);
    return;
  }

  if (ptype === "token_count") {
    const info = pl.info as
      | { last_token_usage?: Record<string, unknown> }
      | null
      | undefined;
    const last = info?.last_token_usage;
    if (!last) return;
    const inputTokens = numTok(last.input_tokens);
    const cacheReadTokens = numTok(last.cached_input_tokens);
    const outputTokens =
      numTok(last.output_tokens) + numTok(last.reasoning_output_tokens);
    const tokens =
      numTok(last.total_tokens) || inputTokens + cacheReadTokens + outputTokens;
    if (tokens <= 0) {
      ctx.pending = [];
      return;
    }

    acc.agent.messageCount += 1;
    acc.agent.totalTokens += tokens;

    const per =
      ctx.pending.length > 0 ? Math.floor(tokens / ctx.pending.length) : 0;
    for (const tu of ctx.pending) {
      const t = acc.tools.get(tu.name);
      if (t) t.tokens += per;
    }
    ctx.pending = [];
  }
}

/** Split a file's content into lines without allocating an intermediate array
 *  (mirrors the native readers' generator). */
function* splitLines(content: string): Generator<string> {
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      yield content.slice(start, i);
      start = i + 1;
    }
  }
  if (start < content.length) yield content.slice(start);
}

/**
 * Compact, JSON-serializable rollup of ONE transcript file — the cache stores
 * these per file. Tuples (not objects) keep the on-disk cache small:
 *  tools:   [name, count, errors, tokens]
 *  skills:  [name, count, tokens]
 *  agent:   [messageCount, subagentMessages, subagentTokens, totalTokens, userMessageCount]
 *  sessions:[sessionId, assistantMessageCount]
 * Every field is additive across files, so merging a set of per-file rollups is
 * exactly equivalent to folding every record into one accumulator (the tool-error
 * matching that needs within-file ordering already happens per file, before this
 * serialization — the same property the native readers rely on).
 */
export interface AttrFileAgg {
  tools: Array<[string, number, number, number]>;
  skills: Array<[string, number, number]>;
  agent: [number, number, number, number, number];
  sessions: Array<[string, number]>;
}

/** Serialize a per-file accumulator into its cacheable rollup. */
function serializeAcc(acc: Accumulator): AttrFileAgg {
  return {
    tools: [...acc.tools].map(([n, v]) => [n, v.count, v.errors, v.tokens]),
    skills: [...acc.skills].map(([n, v]) => [n, v.count, v.tokens]),
    agent: [
      acc.agent.messageCount,
      acc.agent.subagentMessages,
      acc.agent.subagentTokens,
      acc.agent.totalTokens,
      acc.agent.userMessageCount,
    ],
    sessions: [...acc.sessionMessages].map(([s, c]) => [s, c]),
  };
}

/** Fold one file's cached rollup into the shared cross-file accumulator. */
function mergeAgg(acc: Accumulator, agg: AttrFileAgg): void {
  for (const [n, count, errors, tokens] of agg.tools) {
    const cur = acc.tools.get(n) ?? { count: 0, errors: 0, tokens: 0 };
    cur.count += count;
    cur.errors += errors;
    cur.tokens += tokens;
    acc.tools.set(n, cur);
  }
  for (const [n, count, tokens] of agg.skills) {
    const cur = acc.skills.get(n) ?? { count: 0, tokens: 0 };
    cur.count += count;
    cur.tokens += tokens;
    acc.skills.set(n, cur);
  }
  acc.agent.messageCount += agg.agent[0];
  acc.agent.subagentMessages += agg.agent[1];
  acc.agent.subagentTokens += agg.agent[2];
  acc.agent.totalTokens += agg.agent[3];
  acc.agent.userMessageCount += agg.agent[4];
  for (const [s, c] of agg.sessions) {
    acc.sessionMessages.set(s, (acc.sessionMessages.get(s) ?? 0) + c);
  }
}

/** Parse ONE Claude Code transcript file into its cacheable rollup (single-element
 *  array so it fits the generic per-file cache's `T[]` item contract). */
export function parseClaudeAttrFile(content: string): AttrFileAgg[] {
  const acc = createAccumulator();
  const ctx = createFileContext();
  for (const line of splitLines(content)) {
    if (!line) continue;
    try {
      processRecord(JSON.parse(line), acc, ctx);
    } catch {
      /* malformed line — skip */
    }
  }
  return [serializeAcc(acc)];
}

/** Parse ONE Codex rollout file into its cacheable rollup. */
export function parseCodexAttrFile(content: string): AttrFileAgg[] {
  const acc = createAccumulator();
  const ctx = createCodexContext();
  for (const line of splitLines(content)) {
    if (!line) continue;
    try {
      processCodexRecord(JSON.parse(line), acc, ctx);
    } catch {
      /* malformed line — skip */
    }
  }
  return [serializeAcc(acc)];
}

/** Claude Code transcript roots, including config-dir overrides (best-effort). */
function claudeProjectDirs(): string[] {
  const dirs = [CLAUDE_PROJECTS];
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (cfg) dirs.push(join(cfg, "projects"));
  dirs.push(join(homedir(), ".config", "claude", "projects"));
  return [...new Set(dirs)];
}

/** Recursively list *.jsonl files under a dir, newest first, bounded. */
function listTranscripts(dir: string): string[] {
  const out: Array<{ path: string; mtime: number }> = [];
  const walk = (d: string) => {
    if (out.length >= MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          out.push({ path: p, mtime: statSync(p).mtimeMs });
        } catch {
          /* unreadable — skip */
        }
      }
    }
  };
  walk(dir);
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_FILES)
    .map((f) => f.path);
}

/**
 * Parse local agent transcripts into tool/skill/subagent rollups (plus per-session
 * assistant message counts). Sources: Claude Code (`~/.claude/projects`, plus
 * `CLAUDE_CONFIG_DIR` / `~/.config/claude` overrides) and Codex
 * (`~/.codex/sessions`). ccusage already aggregates many agents for token
 * *totals*; this adds the per-agent attribution (which tools/MCP servers,
 * subagent share) that only lives in the transcripts. We never read repo/project
 * names (`cwd`) or conversation titles. Returns empties when nothing is
 * available — never throws.
 */
export async function collectAttribution(
  env: NodeJS.ProcessEnv = process.env,
): Promise<AttributionResult> {
  const acc = createAccumulator();
  // ONE shared deadline for the whole scan (Claude + Codex), so raising the
  // budget doesn't accidentally double it: readFilesWithCache checks this same
  // absolute timestamp, so the Codex pass sees whatever budget the Claude pass
  // left. With the per-file cache a warm run reads only changed files and never
  // approaches the deadline; a cold run that DOES time out persists its progress
  // and the next tick resumes (mirrors the native readers). `complete` still
  // means "full snapshot" for the server's no-shrink guard — unchanged.
  const deadline = Date.now() + TIME_BUDGET_MS;
  let complete = true;

  const mergeInto = (items: AttrFileAgg[][] | null): void => {
    if (!items) {
      complete = false; // timed out — progress persisted, resume next tick
      return;
    }
    for (const perFile of items) for (const agg of perFile) mergeAgg(acc, agg);
  };

  try {
    // Claude Code — rich format (tool_use, attributionSkill, isSidechain).
    const claudeFiles: string[] = [];
    for (const dir of claudeProjectDirs()) claudeFiles.push(...listTranscripts(dir));
    if (claudeFiles.length > 0) {
      const res = await readFilesWithCache<AttrFileAgg>({
        files: claudeFiles,
        cachePath: nativeCachePath("attribution-claude", env),
        version: ATTRIBUTION_CACHE_VERSION,
        parseFile: parseClaudeAttrFile,
        deadline,
      });
      mergeInto(res.itemsByFile);
    }
    // Codex — rollout format (function_call, token_count).
    const codexFiles = listTranscripts(CODEX_SESSIONS);
    if (codexFiles.length > 0) {
      const res = await readFilesWithCache<AttrFileAgg>({
        files: codexFiles,
        cachePath: nativeCachePath("attribution-codex", env),
        version: ATTRIBUTION_CACHE_VERSION,
        parseFile: parseCodexAttrFile,
        deadline,
      });
      mergeInto(res.itemsByFile);
    }
  } catch {
    /* anything unexpected — return whatever we have (mark partial) */
    complete = false;
  }
  return { ...accumulatorToResult(acc), complete };
}
