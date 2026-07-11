import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cli = join(root, "dist", "index.js");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      WHOBURNEDMORE_CONFIG_DIR: join(root, ".smoke-tmp"),
    },
  });
}

function assert(condition, message, result) {
  if (condition) return;
  console.error(`package smoke failed: ${message}`);
  if (result) {
    console.error(`status: ${result.status}`);
    if (result.stdout) console.error(`stdout:\n${result.stdout}`);
    if (result.stderr) console.error(`stderr:\n${result.stderr}`);
  }
  process.exit(1);
}

const version = run(["--version"]);
assert(version.status === 0, "--version should exit 0", version);
assert(
  version.stdout.trim() === pkg.version,
  `--version should print ${pkg.version}`,
  version,
);

const help = run(["--help"]);
assert(help.status === 0, "--help should exit 0", help);
assert(
  help.stdout.includes("npx whoburnedmore link --token=TOKEN"),
  "help should advertise server linking",
  help,
);

const missingToken = run(["link"]);
assert(missingToken.status === 1, "link without --token should fail", missingToken);
assert(
  missingToken.stderr.includes("missing install token") &&
    !missingToken.stderr.includes("unknown command"),
  "link should dispatch to server-link validation, not unknown-command help",
  missingToken,
);

// Fresh-machine background `sync` must stay COMPLETELY silent: no prompt, no
// output, no submit attempt, exit 0 — an unattended scheduler tick on a machine
// that never on-boarded must never nag or write anywhere.
rmSync(join(root, ".smoke-tmp"), { recursive: true, force: true });
const freshSync = run(["sync"]);
assert(freshSync.status === 0, "fresh-machine sync should exit 0", freshSync);
assert(
  freshSync.stdout.trim() === "" && freshSync.stderr.trim() === "",
  "fresh-machine sync must produce no output (background silence)",
  freshSync,
);

console.log(`package smoke passed for whoburnedmore ${pkg.version}`);
