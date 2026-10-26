// Create a fake "brand new" agent home so the generic discovery reader can be
// exercised end to end against the real CLI.
//
// This writes into the user's home directory (~/.brandnewcli). It is a manual
// test helper, not something the CLI ever runs; pass --clean to remove it.
//
//   node scripts/make-fake-agent.mjs          # plant the fixture
//   node scripts/make-fake-agent.mjs --clean  # remove it
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const root = join(homedir(), ".brandnewcli", "projects", "C--demo");
if (process.argv.includes("--clean")) {
  rmSync(join(homedir(), ".brandnewcli"), { recursive: true, force: true });
  console.log("removed ~/.brandnewcli");
  process.exit(0);
}
mkdirSync(root, { recursive: true });

const lines = [];
for (let i = 1; i <= 5; i++) {
  lines.push(
    JSON.stringify({
      type: "assistant",
      uuid: `u${i}`,
      timestamp: `2026-10-20T10:0${i}:00.000Z`,
      message: {
        id: `m${i}`,
        role: "assistant",
        model: "demo-model-x",
        content: [{ type: "text", text: `hello ${i}` }],
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 5000,
        },
      },
      cwd: "C:\\demo",
      sessionId: "s1",
    }),
  );
}
writeFileSync(join(root, "s1.jsonl"), lines.join("\n") + "\n");
console.log(`created ${lines.length} assistant records in ~/.brandnewcli/projects/C--demo/s1.jsonl`);
