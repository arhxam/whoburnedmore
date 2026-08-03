// Spike: prove the CLI engine runs inside a bun-compiled binary.
import { collectAll } from "../../../src/collect.js";

const started = Date.now();
const result = await collectAll((m) => process.stderr.write(`[progress] ${m}\n`));
const today = new Date().toLocaleDateString("en-CA");
let todayTokens = 0;
const byTool = new Map<string, number>();
for (const e of result.entries) {
  const t = e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;
  byTool.set(e.tool, (byTool.get(e.tool) ?? 0) + t);
  if (e.date === today) todayTokens += t;
}
console.log(JSON.stringify({
  ms: Date.now() - started,
  entries: result.entries.length,
  toolsFound: result.toolsFound,
  todayTokens,
  byTool: Object.fromEntries(byTool),
}, null, 1));
