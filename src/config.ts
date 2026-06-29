import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CliConfig {
  /** Secret that owns this machine's dashboard. The CLI's only identity — the
   *  web is the source of truth for accounts (claim this dashboard there). */
  anonKey?: string;
  /** Epoch ms of the last successful submit. Powers `status` freshness/staleness
   *  reporting — a truer signal than the log file's mtime, which moves on any
   *  write (including errors). */
  lastSyncAt?: number;
  /** Epoch ms after the one-time launch-open desktop notification was delivered. */
  launchNotificationDeliveredAt?: number;
}

export function defaultConfigDir(): string {
  const override = process.env.WHOBURNEDMORE_CONFIG_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".config", "whoburnedmore");
}

export function loadConfig(dir: string = defaultConfigDir()): CliConfig | null {
  const file = join(dir, "config.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<
      string,
      unknown
    >;
    const config: CliConfig = {};
    if (typeof parsed.anonKey === "string") config.anonKey = parsed.anonKey;
    if (typeof parsed.lastSyncAt === "number" && Number.isFinite(parsed.lastSyncAt))
      config.lastSyncAt = parsed.lastSyncAt;
    if (
      typeof parsed.launchNotificationDeliveredAt === "number" &&
      Number.isFinite(parsed.launchNotificationDeliveredAt)
    ) {
      config.launchNotificationDeliveredAt = parsed.launchNotificationDeliveredAt;
    }
    return Object.keys(config).length > 0 ? config : null;
  } catch {
    return null;
  }
}

export function saveConfig(
  dir: string = defaultConfigDir(),
  config: CliConfig = {},
): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "config.json");
  // Write owner-only to a fresh temp file, then atomically rename it over the
  // target. This file holds the anonKey secret, so writing in place would (a) leave
  // a brief world-readable window when the config already existed with looser perms
  // — writeFileSync's `mode` only applies to a freshly-created inode — and (b) follow
  // a symlink an attacker may have planted at config.json. The fresh-inode + rename
  // avoids both: the secret only ever exists at 0600, and the rename can't traverse a
  // symlink at the destination.
  const tmp = join(dir, `config.json.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      /* best-effort: some filesystems (e.g. Windows) don't support POSIX modes */
    }
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* ignore cleanup failure */
    }
    throw err;
  }
}

/**
 * Return this machine's anonymous-dashboard secret, generating and persisting
 * one on first use. Preserves any existing signed-in token/handle in the file.
 */
export function ensureAnonKey(dir: string = defaultConfigDir()): string {
  const config = loadConfig(dir) ?? {};
  if (config.anonKey) return config.anonKey;
  const anonKey = randomBytes(32).toString("hex");
  saveConfig(dir, { ...config, anonKey });
  return anonKey;
}

/**
 * Stamp the time of a successful submit, preserving the rest of the config
 * (notably `anonKey`). `status` reads this to report freshness/staleness.
 */
export function recordSync(
  dir: string = defaultConfigDir(),
  when: number = Date.now(),
): void {
  const config = loadConfig(dir) ?? {};
  saveConfig(dir, { ...config, lastSyncAt: when });
}

export function recordLaunchNotificationDelivered(
  dir: string = defaultConfigDir(),
  when: number = Date.now(),
): void {
  const config = loadConfig(dir) ?? {};
  saveConfig(dir, { ...config, launchNotificationDeliveredAt: when });
}

export function loadEnv(): void {
  const dirs = [process.cwd(), defaultConfigDir()];
  for (const dir of dirs) {
    const file = join(dir, ".env");
    if (!existsSync(file)) continue;
    try {
      const content = readFileSync(file, "utf8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const index = trimmed.indexOf("=");
        if (index === -1) continue;
        const key = trimmed.slice(0, index).trim();
        let val = trimmed.slice(index + 1).trim();
        if (
          (val.startsWith('"') && val.endsWith('"')) ||
          (val.startsWith("'") && val.endsWith("'"))
        ) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    } catch {
      /* best-effort */
    }
  }
}

