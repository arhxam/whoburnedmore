/**
 * Interactive & non-interactive first-time setup for Devin Cloud
 * (`npx whoburnedmore setup-devin`).
 *
 * Persists credentials and preferences in `<configDir>/devin-cloud.json`
 * (mode 0600) so unattended 15-minute background syncs pick them up without
 * relying on interactive shell environment variables. Secrets are never
 * accepted via command-line flags (which leak into shell history / `ps`) and
 * are never printed back to stdout.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import {
  clearDevinCloudConfig,
  collectDevinCloud,
  collectDevinCloudLocalSessions,
  DEFAULT_DEVIN_ACU_USD,
  devinAcpMessagesDirs,
  devinCloudConfigPath,
  fetchDevinAnalytics,
  fetchDevinSelf,
  fetchDevinV3Consumption,
  loadDevinCloudConfig,
  readDevinCliCredentials,
  readDevinOrgId,
  resolveDevinAcuUsd,
  saveDevinCloudConfig,
  type DevinCloudConfig,
  type DevinSelfInfo,
} from "./devin-cloud.js";
import { devinCliRoots, listDevinSessionLogs } from "./native/devin.js";
import { formatTokens, formatUSD } from "./output.js";
import { entryTotalTokens } from "./shared.js";

export interface DevinSetupFlags {
  status?: boolean;
  reset?: boolean;
  useDevinCli?: boolean;
  acuUsd?: number;
}

export interface DevinSetupDeps {
  env?: NodeJS.ProcessEnv;
  configPath?: string;
  acpMessagesDirs?: string[];
  cliRoots?: string[];
  fetchImpl?: typeof fetch;
  isTTY?: boolean;
  ask?: (prompt: string) => Promise<string>;
  log?: (line: string) => void;
  now?: number;
}

export interface DevinDiagnostics {
  localCliLogs: number;
  hasSessionsDb: boolean;
  desktopCloudSessions: number;
  desktopCloudAcus: number;
  hasCliCredentials: boolean;
  cliCredsFile?: string;
  cliSelf?: DevinSelfInfo;
  detectedOrgId?: string;
  savedConfig: DevinCloudConfig | null;
  configFile: string;
}

/** Detect all local Devin stores, credentials, and saved setup state. */
export async function inspectDevinEnvironment(
  deps: Pick<DevinSetupDeps, "env" | "configPath" | "acpMessagesDirs" | "cliRoots" | "fetchImpl" | "now"> = {},
): Promise<DevinDiagnostics> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now();
  const roots = deps.cliRoots ?? devinCliRoots(env);
  const localCliLogs = (await listDevinSessionLogs(roots)).length;
  const hasSessionsDb = roots.some((r) => existsSync(join(r, "sessions.db")));

  const localCloud = collectDevinCloudLocalSessions({
    acpMessagesDirs: deps.acpMessagesDirs ?? devinAcpMessagesDirs(env),
    env,
    now,
  });
  const desktopCloudAcus = localCloud.sessions.reduce((sum, s) => sum + s.totalAcus, 0);

  const cliCreds = readDevinCliCredentials(env);
  let cliSelf: DevinSelfInfo | undefined;
  if (cliCreds) {
    try {
      cliSelf = await fetchDevinSelf(cliCreds.apiKey, {
        baseUrl: cliCreds.devinApiUrl,
        fetchImpl: deps.fetchImpl,
      });
    } catch {
      /* offline or expired session token */
    }
  }

  const savedConfig = loadDevinCloudConfig(env, deps.configPath);
  const detectedOrgId =
    savedConfig?.orgId ?? cliSelf?.orgId ?? readDevinOrgId(env) ?? undefined;

  return {
    localCliLogs,
    hasSessionsDb,
    desktopCloudSessions: localCloud.sessions.length,
    desktopCloudAcus,
    hasCliCredentials: Boolean(cliCreds),
    cliCredsFile: cliCreds?.filePath,
    cliSelf,
    detectedOrgId,
    savedConfig,
    configFile: deps.configPath ?? devinCloudConfigPath(env),
  };
}

/** Format non-secret diagnostic lines for `setup-devin` and `setup-devin --status`. */
export function formatDevinDiagnostics(diag: DevinDiagnostics, env: NodeJS.ProcessEnv = process.env): string[] {
  const lines: string[] = [];
  lines.push(`  ${pc.bold("Devin environment")}`);

  const cliParts: string[] = [];
  if (diag.localCliLogs > 0) cliParts.push(`${diag.localCliLogs} session log(s)`);
  if (diag.hasSessionsDb) cliParts.push("sessions.db");
  lines.push(
    `  Local Devin CLI:       ${cliParts.length > 0 ? pc.green(cliParts.join(" + ")) : pc.dim("not found")}`,
  );

  lines.push(
    `  Devin Desktop cache:   ${
      diag.desktopCloudSessions > 0
        ? pc.green(
            `${diag.desktopCloudSessions} cloud session(s) (${diag.desktopCloudAcus.toFixed(4)} ACU cached)`,
          )
        : pc.dim("no cached cloud sessions found")
    }`,
  );

  if (diag.hasCliCredentials) {
    const who = diag.cliSelf
      ? `${diag.cliSelf.userName ?? diag.cliSelf.userId ?? "signed in"}${diag.cliSelf.orgId ? ` · ${diag.cliSelf.orgId}` : ""}`
      : "found (could not verify online)";
    lines.push(`  Devin CLI login:       ${pc.green(who)}`);
  } else {
    lines.push(`  Devin CLI login:       ${pc.dim("not logged in (`devin auth login`)")}`);
  }

  const cfg = diag.savedConfig;
  const effectiveAcuUsd = resolveDevinAcuUsd(env, cfg);
  lines.push("");
  lines.push(`  ${pc.bold("Saved whoburnedmore Devin Cloud config")} ${pc.dim(`(${diag.configFile})`)}`);
  if (!cfg) {
    lines.push(`  Status:                ${pc.dim("not configured (using local Desktop cache only)")}`);
  } else {
    const modes: string[] = [];
    if (cfg.analyticsServiceKey) modes.push("Analytics v2alpha key (saved)");
    if (cfg.apiKey) modes.push("Devin v3 API key (saved)");
    if (cfg.useLocalCliCredentials) modes.push("Devin CLI login (~/.local/share/devin/credentials.toml)");
    if (modes.length === 0) modes.push("Local Desktop cache only");
    lines.push(`  Auth source:           ${pc.green(modes.join(", "))}`);
    if (cfg.orgId) lines.push(`  Org ID:                ${cfg.orgId}`);
    if (cfg.userId) lines.push(`  User ID:               ${cfg.userId}`);
    if (cfg.serviceUserId) lines.push(`  Service User ID:       ${cfg.serviceUserId}`);
  }
  lines.push(`  ACU rate:              $${effectiveAcuUsd.toFixed(2)}/ACU`);

  const envOverrides: string[] = [];
  if (env.DEVIN_ANALYTICS_SERVICE_KEY?.trim()) envOverrides.push("DEVIN_ANALYTICS_SERVICE_KEY");
  if (env.DEVIN_API_KEY?.trim()) envOverrides.push("DEVIN_API_KEY");
  if (env.WHOBURNEDMORE_DEVIN_ACU_USD?.trim()) envOverrides.push("WHOBURNEDMORE_DEVIN_ACU_USD");
  if (env.WHOBURNEDMORE_DEVIN_CLOUD === "0") envOverrides.push("WHOBURNEDMORE_DEVIN_CLOUD=0 (disabled)");
  if (envOverrides.length > 0) {
    lines.push(`  Env overrides:         ${pc.yellow(envOverrides.join(", "))}`);
  }
  return lines;
}

function parseAcuRateInput(raw: string, fallback: number): number | null {
  const trimmed = raw.trim().replace(/^\$/, "");
  if (!trimmed) return fallback;
  const v = Number(trimmed);
  if (!Number.isFinite(v) || v <= 0 || v > 1000) return null;
  return v;
}

/** Run `npx whoburnedmore setup-devin`. */
export async function runDevinSetup(
  flags: DevinSetupFlags = {},
  deps: DevinSetupDeps = {},
): Promise<{ saved: boolean; config: DevinCloudConfig | null }> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now();
  const log = deps.log ?? ((line: string) => console.log(line));
  const isTTY = deps.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);

  if (flags.reset) {
    const removed = clearDevinCloudConfig(env, deps.configPath);
    log(
      removed
        ? `  ${pc.green("✓")} Removed saved Devin Cloud config (${deps.configPath ?? devinCloudConfigPath(env)}).`
        : "  No saved Devin Cloud config found.",
    );
    return { saved: false, config: null };
  }

  const diag = await inspectDevinEnvironment(deps);

  if (flags.status) {
    log("");
    for (const line of formatDevinDiagnostics(diag, env)) log(line);
    log("");
    return { saved: false, config: diag.savedConfig };
  }

  // Non-interactive rate-only update: `whoburnedmore setup-devin --acu-usd=2.25`
  if (flags.acuUsd !== undefined && !flags.useDevinCli && !env.DEVIN_API_KEY && !env.DEVIN_ANALYTICS_SERVICE_KEY) {
    const next: DevinCloudConfig = {
      ...(diag.savedConfig ?? {}),
      acuUsd: flags.acuUsd,
      configuredAt: now,
    };
    if (!saveDevinCloudConfig(next, env, deps.configPath)) {
      throw new Error("could not write Devin Cloud config file");
    }
    log(`  ${pc.green("✓")} Updated Devin ACU rate to $${flags.acuUsd.toFixed(2)}/ACU.`);
    return { saved: true, config: next };
  }

  // Non-interactive `--use-devin-cli` setup
  if (flags.useDevinCli) {
    if (!diag.hasCliCredentials) {
      throw new Error("Devin CLI credentials not found — run `devin auth login` first.");
    }
    const next: DevinCloudConfig = {
      useLocalCliCredentials: true,
      ...(diag.detectedOrgId ? { orgId: diag.detectedOrgId } : {}),
      ...(diag.cliSelf?.userId ? { userId: diag.cliSelf.userId } : {}),
      ...(diag.cliSelf?.userName ? { userName: diag.cliSelf.userName } : {}),
      acuUsd: flags.acuUsd ?? resolveDevinAcuUsd(env, diag.savedConfig),
      configuredAt: now,
    };
    if (!saveDevinCloudConfig(next, env, deps.configPath)) {
      throw new Error("could not write Devin Cloud config file");
    }
    log(`  ${pc.green("✓")} Configured Devin Cloud using your local Devin CLI login.`);
    await printLivePreview(next, deps, log);
    return { saved: true, config: next };
  }

  // Non-interactive env-var ingestion (saves validated env key to 0600 config for background sync)
  if (!isTTY && !deps.ask) {
    const envAnalytics = env.DEVIN_ANALYTICS_SERVICE_KEY?.trim();
    const envApi = env.DEVIN_API_KEY?.trim();
    if (envAnalytics) {
      const next = await configureAnalyticsKey(envAnalytics, diag, flags.acuUsd, deps, log);
      return { saved: true, config: next };
    }
    if (envApi) {
      const next = await configureDevinApiKey(envApi, diag, flags.acuUsd, deps, log);
      return { saved: true, config: next };
    }
    throw new Error(
      "setup-devin requires an interactive terminal, or pass --use-devin-cli / --status / --reset (or set DEVIN_API_KEY / DEVIN_ANALYTICS_SERVICE_KEY).",
    );
  }

  log("");
  for (const line of formatDevinDiagnostics(diag, env)) log(line);
  log("");
  log(`  ${pc.bold("Choose how whoburnedmore should read Devin Cloud:")}`);
  log(`  ${pc.bold("[1]")} Local Devin CLI login + Desktop cache ${pc.dim("(zero extra keys; Pro / Max / Teams)")}`);
  log(`  ${pc.bold("[2]")} Devin Personal Access Token or Service User key ${pc.dim("(cog_…; Enterprise daily ACUs + all org sessions)")}`);
  log(`  ${pc.bold("[3]")} Devin Analytics v2alpha Service Key ${pc.dim("(exact per-model tokens on DOLLARS-billed teams)")}`);
  log(`  ${pc.bold("[4]")} Local Desktop cache only ${pc.dim("(offline; no Devin API calls)")}`);
  log("");

  const rl = deps.ask ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = deps.ask ?? ((prompt: string) => rl!.question(prompt));

  try {
    const defaultChoice = diag.hasCliCredentials ? "1" : "2";
    const choiceRaw = (await ask(`  Select [1-4] (default ${defaultChoice}): `)).trim() || defaultChoice;

    const currentRate = flags.acuUsd ?? resolveDevinAcuUsd(env, diag.savedConfig);
    let next: DevinCloudConfig;

    if (choiceRaw === "1") {
      if (!diag.hasCliCredentials) {
        log(pc.yellow("  No Devin CLI login found. Run `devin auth login` first, then re-run `npx whoburnedmore setup-devin`."));
        return { saved: false, config: diag.savedConfig };
      }
      const rateStr = await ask(`  USD per ACU (default $${currentRate.toFixed(2)}): `);
      const acuUsd = parseAcuRateInput(rateStr, currentRate);
      if (acuUsd === null) throw new Error("invalid ACU rate (must be a number between 0 and 1000)");

      next = {
        useLocalCliCredentials: true,
        ...(diag.detectedOrgId ? { orgId: diag.detectedOrgId } : {}),
        ...(diag.cliSelf?.userId ? { userId: diag.cliSelf.userId } : {}),
        ...(diag.cliSelf?.userName ? { userName: diag.cliSelf.userName } : {}),
        acuUsd,
        configuredAt: now,
      };
      if (!saveDevinCloudConfig(next, env, deps.configPath)) {
        throw new Error("could not write Devin Cloud config file");
      }
      log("");
      log(`  ${pc.green("✓")} Saved Devin Cloud setup to ${diag.configFile} (mode 0600).`);
    } else if (choiceRaw === "2") {
      log(pc.dim("  Create a PAT or Service User key in app.devin.ai → Settings → Devin API."));
      const key = (await ask("  Paste your Devin API key (cog_...): ")).trim();
      if (!key) throw new Error("no Devin API key entered");
      const rateStr = await ask(`  USD per ACU (default $${currentRate.toFixed(2)}): `);
      const acuUsd = parseAcuRateInput(rateStr, currentRate);
      if (acuUsd === null) throw new Error("invalid ACU rate (must be a number between 0 and 1000)");
      next = await configureDevinApiKey(key, diag, acuUsd, deps, log);
    } else if (choiceRaw === "3") {
      log(pc.dim("  Create a Service Key with Analytics Read permission in Team Settings → Service Keys."));
      const key = (await ask("  Paste your Analytics Service Key: ")).trim();
      if (!key) throw new Error("no Analytics Service Key entered");
      const defaultUid = diag.cliSelf?.userId ?? diag.savedConfig?.userId ?? "";
      const uidPrompt = defaultUid
        ? `  Devin User ID to filter to (default ${defaultUid}, '-' for all): `
        : "  Devin User ID to filter to (optional, press Enter to skip): ";
      const uidRaw = (await ask(uidPrompt)).trim();
      const userId = uidRaw === "-" ? undefined : uidRaw || defaultUid || undefined;
      const rateStr = await ask(`  USD per ACU for ACU-billed rows (default $${currentRate.toFixed(2)}): `);
      const acuUsd = parseAcuRateInput(rateStr, currentRate);
      if (acuUsd === null) throw new Error("invalid ACU rate (must be a number between 0 and 1000)");
      next = await configureAnalyticsKey(key, diag, acuUsd, deps, log, userId);
    } else if (choiceRaw === "4") {
      const rateStr = await ask(`  USD per ACU (default $${currentRate.toFixed(2)}): `);
      const acuUsd = parseAcuRateInput(rateStr, currentRate);
      if (acuUsd === null) throw new Error("invalid ACU rate (must be a number between 0 and 1000)");
      next = {
        acuUsd,
        configuredAt: now,
      };
      if (!saveDevinCloudConfig(next, env, deps.configPath)) {
        throw new Error("could not write Devin Cloud config file");
      }
      log("");
      log(`  ${pc.green("✓")} Saved local-only Devin Cloud config to ${diag.configFile} (mode 0600).`);
    } else {
      throw new Error(`invalid selection "${choiceRaw}" — choose 1, 2, 3, or 4`);
    }

    await printLivePreview(next, deps, log);
    return { saved: true, config: next };
  } finally {
    rl?.close();
  }
}

async function configureDevinApiKey(
  apiKey: string,
  diag: DevinDiagnostics,
  acuUsdOverride: number | undefined,
  deps: DevinSetupDeps,
  log: (line: string) => void,
): Promise<DevinCloudConfig> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now();
  const baseUrl = env.DEVIN_API_URL?.trim() || undefined;

  const self = await fetchDevinSelf(apiKey, { baseUrl, fetchImpl: deps.fetchImpl });
  const orgId = env.DEVIN_ORG_ID?.trim() || self.orgId || diag.detectedOrgId;
  const serviceUserId = env.DEVIN_SERVICE_USER_ID?.trim() || self.serviceUserId;
  const userId = env.DEVIN_USER_ID?.trim() || self.userId;

  // Probe whether Enterprise daily consumption is enabled on this plan.
  let enterpriseConsumption = false;
  if (serviceUserId || orgId) {
    try {
      await fetchDevinV3Consumption(apiKey, {
        baseUrl,
        orgId: serviceUserId ? undefined : orgId,
        serviceUserId,
        fetchImpl: deps.fetchImpl,
      });
      enterpriseConsumption = true;
    } catch {
      enterpriseConsumption = false;
    }
  }

  const next: DevinCloudConfig = {
    apiKey,
    ...(orgId ? { orgId } : {}),
    ...(userId ? { userId } : {}),
    ...(serviceUserId ? { serviceUserId } : {}),
    ...(self.userName || self.serviceUserName
      ? { userName: self.userName ?? self.serviceUserName }
      : {}),
    ...(baseUrl ? { apiUrl: baseUrl } : {}),
    acuUsd: acuUsdOverride ?? resolveDevinAcuUsd(env, diag.savedConfig),
    configuredAt: now,
  };
  if (!saveDevinCloudConfig(next, env, deps.configPath)) {
    throw new Error("could not write Devin Cloud config file");
  }

  log("");
  log(
    `  ${pc.green("✓")} Verified Devin API key (${self.principalType}${next.userName ? ` · ${next.userName}` : ""}${orgId ? ` · ${orgId}` : ""}).`,
  );
  log(
    enterpriseConsumption
      ? `  ${pc.green("✓")} Enterprise daily consumption API is enabled.`
      : pc.dim("  Note: Enterprise daily consumption API is not enabled on this plan; using org sessions + local Desktop cache."),
  );
  log(`  ${pc.green("✓")} Saved config to ${diag.configFile} (mode 0600).`);
  return next;
}

async function configureAnalyticsKey(
  analyticsServiceKey: string,
  diag: DevinDiagnostics,
  acuUsdOverride: number | undefined,
  deps: DevinSetupDeps,
  log: (line: string) => void,
  explicitUserId?: string,
): Promise<DevinCloudConfig> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now();
  const baseUrl = env.DEVIN_ANALYTICS_API_URL?.trim() || undefined;
  const userId = explicitUserId ?? env.DEVIN_USER_ID?.trim() ?? diag.cliSelf?.userId ?? diag.savedConfig?.userId;

  // Validate key with a real API call before saving.
  const rows = await fetchDevinAnalytics(analyticsServiceKey, {
    baseUrl,
    userId,
    now,
    maxPages: 1,
    fetchImpl: deps.fetchImpl,
  });
  const hasTokens = rows.some(
    (r) =>
      (r.tokens?.input_tokens ?? 0) +
        (r.tokens?.output_tokens ?? 0) +
        (r.tokens?.cache_read_tokens ?? 0) +
        (r.tokens?.cache_write_tokens ?? 0) >
      0,
  );

  const next: DevinCloudConfig = {
    analyticsServiceKey,
    ...(userId ? { userId } : {}),
    ...(diag.detectedOrgId ? { orgId: diag.detectedOrgId } : {}),
    ...(baseUrl ? { analyticsApiUrl: baseUrl } : {}),
    acuUsd: acuUsdOverride ?? resolveDevinAcuUsd(env, diag.savedConfig),
    configuredAt: now,
  };
  if (!saveDevinCloudConfig(next, env, deps.configPath)) {
    throw new Error("could not write Devin Cloud config file");
  }

  log("");
  log(`  ${pc.green("✓")} Verified Analytics v2alpha Service Key (${rows.length} row(s) returned).`);
  log(
    hasTokens
      ? `  ${pc.green("✓")} Granular per-model token counts detected!`
      : pc.dim("  Note: your team uses ACU/credit billing (no per-token object returned); recording ACU cost."),
  );
  log(`  ${pc.green("✓")} Saved config to ${diag.configFile} (mode 0600).`);
  return next;
}

async function printLivePreview(
  config: DevinCloudConfig,
  deps: DevinSetupDeps,
  log: (line: string) => void,
): Promise<void> {
  const res = await collectDevinCloud({
    offline: false,
    env: deps.env,
    acpMessagesDirs: deps.acpMessagesDirs,
    configPath: deps.configPath,
    now: deps.now,
    fetchImpl: deps.fetchImpl,
  });
  const totalTokens = res.entries.reduce((s, e) => s + entryTotalTokens(e), 0);
  const totalCost = res.entries.reduce((s, e) => s + e.costUSD, 0);
  const days = new Set(res.entries.map((e) => e.date)).size;

  log("");
  if (res.entries.length > 0) {
    log(
      `  ${pc.green("✓")} Live check: ${res.entries.length} devin-cloud row(s) across ${days} day(s) — ${formatTokens(totalTokens)} tokens, ${formatUSD(totalCost)}`,
    );
  } else {
    log(
      pc.dim(
        "  Live check: 0 Devin Cloud rows with usage so far (run a Devin Cloud session, or check `npx whoburnedmore --dry-run`).",
      ),
    );
  }
  if (totalTokens === 0 && !config.analyticsServiceKey) {
    log(
      pc.dim(
        `  Note: Cognition meters non-DOLLARS Devin Cloud plans in ACUs ($${(config.acuUsd ?? DEFAULT_DEVIN_ACU_USD).toFixed(2)}/ACU) without exposing LLM token counts; cost is tracked without fabricating tokens.`,
      ),
    );
  }
  log(pc.dim("  Run `npx whoburnedmore --dry-run` to preview, or `npx whoburnedmore` to sync."));
  log("");
}
