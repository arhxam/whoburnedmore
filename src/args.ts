/** CLI argument helpers, kept separate from index.ts so they're unit-testable
 *  without triggering the CLI's top-level main() run. */

/** Parse `--board=<code>` or `--board <code>` from argv; undefined if absent. */
export function parseBoard(args: string[]): string | undefined {
  return parseValueFlag(args, "--board");
}

/** Parse `--org=<slug>` or `--org <slug>` from argv; undefined if absent. */
export function parseOrg(args: string[]): string | undefined {
  return parseValueFlag(args, "--org");
}

/**
 * Parse the org join password from `--pass=<code>` / `--pass <code>` (or its
 * `--code` alias); undefined if absent. Required to attach a run to an `--org`.
 */
export function parsePass(args: string[]): string | undefined {
  return parseValueFlag(args, "--pass") ?? parseValueFlag(args, "--code");
}

/** Parse `--token=<install-token>` or `--token <install-token>` for server linking. */
export function parseInstallToken(args: string[]): string | undefined {
  return parseValueFlag(args, "--token");
}

/** Secrets in argv are visible to process listings and persist in shell history. */
export function hasUnsafeInstallTokenArg(args: string[]): boolean {
  return args.some((arg) => arg === "--token" || arg.startsWith("--token="));
}

/** The optional board/org scope a run can submit into. */
export interface ScopeFlags {
  board?: string;
  org?: string;
  /** Org join password — only meaningful alongside `org`. */
  orgCode?: string;
}

/**
 * Attach the optional `board`/`org` scope to a submit payload, only when set —
 * so a plain run produces a payload with NEITHER key (back-compat). Pure and
 * unit-testable; used by run() in index.ts.
 */
export function applyScope<T extends Record<string, unknown>>(
  payload: T,
  flags: ScopeFlags,
): T {
  if (flags.board) (payload as Record<string, unknown>).board = flags.board;
  if (flags.org) (payload as Record<string, unknown>).org = flags.org;
  if (flags.org && flags.orgCode)
    (payload as Record<string, unknown>).orgCode = flags.orgCode;
  return payload;
}

/** Flags that take a value (`--board CODE` / `--board=CODE`). */
const VALUE_FLAGS = new Set(["--board", "--org", "--token", "--pass", "--code"]);

/** Every flag the CLI understands. Anything else is a typo, not a no-op. */
const KNOWN_FLAGS = new Set([
  ...VALUE_FLAGS,
  "--dry-run",
  "--no-submit",
  "--local",
  "--watch",
  "--help",
  "-h",
  "--version",
  "-v",
]);

/** Flags whose whole point is that nothing is uploaded. */
const NO_UPLOAD_FLAGS = ["--dry-run", "--no-submit", "--local"];

/**
 * Reject argv that would otherwise do something the user did not ask for.
 * Returns a message to print, or null when the arguments are fine.
 *
 * The default command uploads usage publicly, so silently ignoring a flag is
 * never harmless: a typo such as `--dryrun`, a flag from another tool, a
 * `--board` with no code, or `--dry-run --watch` (the daemon always uploads)
 * all used to fall through to a real upload.
 */
export function argumentProblem(args: string[], command: string): string | null {
  if (command === "help" || command === "version") return null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) continue;
    const name = a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
    if (!KNOWN_FLAGS.has(name)) return `Unknown option ${name}.`;
    // On/off flags are matched exactly elsewhere, so `--dry-run=true` would be
    // accepted here yet NOT treated as --dry-run: refuse the `=` form.
    if (!VALUE_FLAGS.has(name) && a.includes("=")) {
      return `${name} doesn't take a value; use ${name} on its own.`;
    }
    if (VALUE_FLAGS.has(name)) {
      if (parseValueFlag([a, args[i + 1] ?? ""], name) === undefined) {
        const example = { "--board": "CODE", "--org": "SLUG", "--token": "TOKEN" }[name] ?? "PASSWORD";
        return `${name} needs a value, for example ${name}=${example}.`;
      }
      if (!a.includes("=")) i++;
    }
  }
  const noUpload = NO_UPLOAD_FLAGS.filter((f) => args.includes(f));
  if (args.includes("--watch")) {
    if (command !== "run" && command !== "sync" && command !== "daemon") {
      return `--watch only works with sync (it keeps uploading every 15 minutes).`;
    }
    if (noUpload.length > 0) {
      return `--watch keeps uploading every 15 minutes, so it can't be combined with ${noUpload.join(", ")}.`;
    }
  }
  if ((command === "sync" || command === "daemon") && noUpload.length > 0) {
    return `${command} always uploads, so it can't be combined with ${noUpload.join(", ")}. To preview without sending, run \`npx whoburnedmore --dry-run\`.`;
  }
  // --dry-run/--local/--no-submit only change the default command; every other
  // command would silently ignore them (link and verify still send data).
  if (command !== "run" && noUpload.length > 0) {
    return `${noUpload.join(", ")} only works with the default command, not \`${command}\`.`;
  }
  return null;
}

/** Shared `--name=value` / `--name value` reader; ignores empty and following flags. */
function parseValueFlag(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const eq = args.find((a) => a.startsWith(prefix));
  if (eq) return eq.slice(prefix.length).trim() || undefined;
  const i = args.indexOf(name);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("-")) {
    return args[i + 1].trim() || undefined;
  }
  return undefined;
}

/**
 * Resolve which command the CLI should dispatch from argv.
 *
 * Help/version are checked FIRST, including their flag spellings (`--help`,
 * `-h`, `--version`, `-v`). They start with "-", so the old "first non-dash arg
 * else run" logic never matched them and `whoburnedmore --help` fell through to
 * a real `run` — silently collecting and PUBLICLY submitting the user's usage.
 * Recognising the flags here keeps `--help`/`-h` informational and side-effect
 * free. After that, an explicit subcommand wins; otherwise the default is `run`.
 * Unknown words are returned verbatim so main() can report "unknown command".
 */
export function resolveCommand(args: string[]): string {
  // Partition argv, skipping the value token that follows a value-flag
  // (`--board CODE`, `--org SLUG`) so a value like `--board help` is never treated
  // as the help subcommand/flag. `flags` holds dash tokens (their own flags);
  // `words` holds non-dash tokens that aren't a flag's value.
  const flags: string[] = [];
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      flags.push(a);
      // Skip the value only when the next token IS a value: `--board --help`
      // must still see `--help` (parseValueFlag never takes a dash token).
      if (VALUE_FLAGS.has(a) && args[i + 1] !== undefined && !args[i + 1].startsWith("-")) i++;
      continue;
    }
    words.push(a);
  }
  // Help/version FIRST — the flag spellings start with "-", so the old "first
  // non-dash arg else run" logic never matched them and `whoburnedmore --help`
  // fell through to a real `run` that PUBLICLY submitted usage. Recognising them
  // here keeps `--help`/`-h`/`--version`/`-v` (and the bareword forms) side-effect
  // free — but only when `help`/`version` is a genuine word, not a flag's value.
  if (flags.includes("--help") || flags.includes("-h") || words.includes("help")) {
    return "help";
  }
  if (
    flags.includes("--version") ||
    flags.includes("-v") ||
    words.includes("version")
  ) {
    return "version";
  }
  // An explicit subcommand wins; otherwise the default is `run`.
  return words[0] ?? "run";
}

/** Interpret a typed yes/no answer; an empty answer (just Enter) takes the default. */
export function confirmAnswer(answer: string, defaultYes: boolean): boolean {
  const a = answer.trim();
  return a === "" ? defaultYes : /^y(es)?$/i.test(a);
}
