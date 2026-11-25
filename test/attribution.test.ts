import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  accumulatorToResult,
  collectAttribution,
  countRecord,
  createAccumulator,
  createCodexContext,
  createFileContext,
  processCodexRecord,
  processRecord,
} from "../src/attribution.js";

const assistant = (over: Record<string, unknown> = {}) => ({
  type: "assistant",
  cwd: "/home/dev/project-alpha",
  sessionId: "sess-1",
  isSidechain: false,
  message: {
    role: "assistant",
    model: "claude-opus-4-8",
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 40,
    },
    content: [{ type: "text", text: "ok" }],
  },
  ...over,
});

describe("countRecord", () => {
  it("counts tool_use names in an assistant message", () => {
    const tools = new Map<string, number>();
    const skills = new Map<string, number>();
    countRecord(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
            { type: "tool_use", name: "Read" },
            { type: "tool_use", name: "mcp__playwright__browser_navigate" },
          ],
        },
      },
      tools,
      skills,
    );
    expect(tools.get("Bash")).toBe(1);
    expect(tools.get("Read")).toBe(1);
    expect(tools.get("mcp__playwright__browser_navigate")).toBe(1);
  });

  it("accumulates across records and counts attributionSkill", () => {
    const tools = new Map<string, number>();
    const skills = new Map<string, number>();
    const rec = (skill: string) => ({
      attributionSkill: skill,
      message: { content: [{ type: "tool_use", name: "Bash" }] },
    });
    countRecord(rec("ultragoal:goal"), tools, skills);
    countRecord(rec("ultragoal:goal"), tools, skills);
    countRecord(rec("superpowers:brainstorming"), tools, skills);
    expect(tools.get("Bash")).toBe(3);
    expect(skills.get("ultragoal:goal")).toBe(2);
    expect(skills.get("superpowers:brainstorming")).toBe(1);
  });

  it("ignores records with no content or bad shapes", () => {
    const tools = new Map<string, number>();
    const skills = new Map<string, number>();
    countRecord(null, tools, skills);
    countRecord({ type: "user" }, tools, skills);
    countRecord({ message: { content: "nope" } }, tools, skills);
    countRecord({ message: { content: [{ type: "text" }] } }, tools, skills);
    expect(tools.size).toBe(0);
    expect(skills.size).toBe(0);
  });
});

describe("processRecord — subagent vs main split", () => {
  it("counts subagent messages + tokens separately from the total", () => {
    const acc = createAccumulator();
    const ctx = createFileContext();
    processRecord(assistant(), acc, ctx); // main
    processRecord(assistant({ isSidechain: true }), acc, ctx); // subagent
    processRecord(assistant({ isSidechain: true }), acc, ctx); // subagent
    const { agent } = accumulatorToResult(acc);
    expect(agent.messageCount).toBe(3);
    expect(agent.subagentMessages).toBe(2);
    expect(agent.totalTokens).toBe(600);
    expect(agent.subagentTokens).toBe(400);
  });
});

describe("processRecord — human-sent message count", () => {
  const userMsg = (over: Record<string, unknown> = {}) => ({
    type: "user",
    isSidechain: false,
    message: { role: "user", content: [{ type: "text", text: "fix the bug" }] },
    ...over,
  });

  it("counts only genuine human prompts (not tool results, sidechain, meta, or system reminders)", () => {
    const acc = createAccumulator();
    const ctx = createFileContext();
    processRecord(userMsg(), acc, ctx); // ✓ real prompt
    processRecord(userMsg({ message: { role: "user", content: "plain string prompt" } }), acc, ctx); // ✓ string content
    processRecord(userMsg({ isSidechain: true }), acc, ctx); // ✗ subagent's injected prompt
    processRecord(userMsg({ isMeta: true }), acc, ctx); // ✗ meta/injected turn
    processRecord(
      userMsg({ message: { role: "user", content: [{ type: "text", text: "<system-reminder>do x</system-reminder>" }] } }),
      acc,
      ctx,
    ); // ✗ system reminder
    processRecord(
      userMsg({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
      acc,
      ctx,
    ); // ✗ tool result turn (no human text)
    const { agent } = accumulatorToResult(acc);
    expect(agent.userMessageCount).toBe(2);
  });
});

describe("processRecord — message counts per session", () => {
  it("counts assistant messages overall and per sessionId", () => {
    const acc = createAccumulator();
    const ctx = createFileContext();
    processRecord(assistant({ sessionId: "a" }), acc, ctx);
    processRecord(assistant({ sessionId: "a" }), acc, ctx);
    processRecord(assistant({ sessionId: "b" }), acc, ctx);
    const { agent, sessionMessages } = accumulatorToResult(acc);
    expect(agent.messageCount).toBe(3);
    expect(sessionMessages.get("a")).toBe(2);
    expect(sessionMessages.get("b")).toBe(1);
  });
});

describe("processRecord — tool reliability (errors by tool_use_id)", () => {
  it("attributes a tool_result error to the tool that issued it", () => {
    const acc = createAccumulator();
    const ctx = createFileContext();
    // assistant issues two Bash calls + one Read.
    processRecord(
      assistant({
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "Bash" },
            { type: "tool_use", id: "t2", name: "Bash" },
            { type: "tool_use", id: "t3", name: "Read" },
          ],
        },
      }),
      acc,
      ctx,
    );
    // user returns: t1 errored, t2 ok, t3 ok.
    processRecord(
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "t1", is_error: true },
            { type: "tool_result", tool_use_id: "t2", is_error: false },
            { type: "tool_result", tool_use_id: "t3", is_error: false },
          ],
        },
      },
      acc,
      ctx,
    );
    const { tools } = accumulatorToResult(acc);
    const bash = tools.find((t) => t.name === "Bash")!;
    const read = tools.find((t) => t.name === "Read")!;
    expect(bash.count).toBe(2);
    expect(bash.errors).toBe(1);
    // Read had no error → omits the errors field (legacy-shaped).
    expect(read.count).toBe(1);
    expect(read.errors).toBeUndefined();
  });
});

describe("processCodexRecord — Codex rollout attribution", () => {
  it("counts tool calls and splits turn tokens (never reads cwd)", () => {
    const acc = createAccumulator();
    const ctx = createCodexContext();
    // session_meta carries cwd + model, which we deliberately ignore now.
    processCodexRecord(
      { type: "session_meta", payload: { cwd: "/home/dev/project-beta", model: "gpt-5.3-codex" } },
      acc,
      ctx,
    );
    // two tool calls this turn
    processCodexRecord(
      { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c1" } },
      acc,
      ctx,
    );
    processCodexRecord(
      { type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: "c2" } },
      acc,
      ctx,
    );
    // token_count closes the turn: 200 total tokens
    processCodexRecord(
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 120,
              cached_input_tokens: 30,
              output_tokens: 40,
              reasoning_output_tokens: 10,
              total_tokens: 200,
            },
          },
        },
      },
      acc,
      ctx,
    );
    const { tools, agent } = accumulatorToResult(acc);
    const exec = tools.find((t) => t.name === "exec_command")!;
    expect(exec.count).toBe(2);
    expect(exec.tokens).toBe(200); // 2 calls × 100 (200 split across the two)
    expect(agent.messageCount).toBe(1);
    expect(agent.totalTokens).toBe(200);
    expect(agent.subagentMessages).toBe(0); // Codex has no subagent concept
  });

  it("ignores token_count records with no usage and bad shapes", () => {
    const acc = createAccumulator();
    const ctx = createCodexContext();
    processCodexRecord(null, acc, ctx);
    processCodexRecord({ type: "event_msg", payload: { type: "token_count", info: null } }, acc, ctx);
    processCodexRecord({ type: "response_item", payload: { type: "message" } }, acc, ctx);
    const { tools, agent } = accumulatorToResult(acc);
    expect(tools.length).toBe(0);
    expect(agent.totalTokens).toBe(0);
  });
});

describe("processRecord — per-tool / per-skill token burn", () => {
  it("splits a turn's tokens across its tool calls and sums skill tokens", () => {
    const acc = createAccumulator();
    const ctx = createFileContext();
    // 200 tokens this turn (100+50+10+40), two tool_use blocks → 100 each.
    processRecord(
      assistant({
        attributionSkill: "ultragoal:goal",
        message: {
          role: "assistant",
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 40,
          },
          content: [
            { type: "tool_use", name: "Bash", id: "t1" },
            { type: "tool_use", name: "Read", id: "t2" },
          ],
        },
      }),
      acc,
      ctx,
    );
    const { tools, skills } = accumulatorToResult(acc);
    const bash = tools.find((t) => t.name === "Bash");
    const read = tools.find((t) => t.name === "Read");
    expect(bash).toMatchObject({ count: 1, tokens: 100 });
    expect(read).toMatchObject({ count: 1, tokens: 100 });
    // The skill on that record gets the full 200-token turn.
    expect(skills.find((s) => s.name === "ultragoal:goal")).toMatchObject({
      count: 1,
      tokens: 200,
    });
  });
});

describe("collectAttribution transcript roots", () => {
  it("scans every comma-separated CLAUDE_CONFIG_DIR root, like the usage reader", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbm-attr-roots-"));
    try {
      const line = (tool: string) =>
        JSON.stringify({
          type: "assistant",
          sessionId: `s-${tool}`,
          message: { role: "assistant", content: [{ type: "tool_use", name: tool }] },
        }) + "\n";
      for (const [dir, tool] of [["a", "Bash"], ["b", "Read"]] as const) {
        await mkdir(join(root, dir, "projects", "p"), { recursive: true });
        await writeFile(join(root, dir, "projects", "p", "t.jsonl"), line(tool));
      }
      // HOME points at an empty dir: nothing outside the configured roots counts.
      const env = {
        HOME: join(root, "home"),
        CLAUDE_CONFIG_DIR: `${join(root, "a")},${join(root, "b")}`,
        CODEX_HOME: join(root, "codex"),
        WHOBURNEDMORE_CONFIG_DIR: join(root, "cfg"),
      } as NodeJS.ProcessEnv;
      const result = await collectAttribution(env);
      expect(result.tools.map((t) => t.name).sort()).toEqual(["Bash", "Read"]);
      expect(result.complete).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
