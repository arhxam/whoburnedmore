import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("native daily leaderboard contract", () => {
  test("fetches and labels a live today-only leaderboard", async () => {
    const [client, popover, model, app] = await Promise.all([
      readFile("Sources/BurnBar/WbmClient.swift", "utf8"),
      readFile("Sources/BurnBar/PopoverView.swift", "utf8"),
      readFile("Sources/BurnBar/AppModel.swift", "utf8"),
      readFile("Sources/BurnBar/BurnBarApp.swift", "utf8"),
    ]);

    expect(client).toContain("period=today&by=tokens");
    expect(client).not.toContain("period=all&by=tokens");
    expect(popover).toContain("Today’s leaderboard");
    expect(popover).toContain('Text("synced")');
    expect(popover).toContain("Formatters.compactTokens(row.todayTokens)");
    expect(popover).toContain("not ranked today");
    expect(popover).not.toContain("all-time tokens");
    expect(popover).not.toContain("today's highest");
    expect(model).toContain("settings.limitsRefreshSeconds");
    expect(model).toContain("await self?.refreshRemote()");
    expect(app).toContain(".onAppear { Task { await model.refreshRemote() } }");
    expect(app).toContain("state.iconName");
    expect(app).not.toContain("exclamationmark.triangle.fill");
  });
});

describe("native provider-first menu builder contract", () => {
  test("chooses a source before a source-valid value", async () => {
    const settings = await readFile("Sources/BurnBar/SettingsWindow.swift", "utf8");

    expect(settings).toContain('Text("Source")');
    expect(settings).toContain('Text("Value")');
    expect(settings).toContain("MenuBarMetric.availableMetrics");
    expect(settings).toContain("MenuBarMetric.normalized");
    expect(settings).toContain('("all", "Overall")');
    expect(settings).not.toContain('"X 71%"');
  });
});

describe("native explicit permission contract", () => {
  test("gates Claude and notification access behind user choices", async () => {
    const [model, onboarding, settings] = await Promise.all([
      readFile("Sources/BurnBar/AppModel.swift", "utf8"),
      readFile("Sources/BurnBar/OnboardingWindow.swift", "utf8"),
      readFile("Sources/BurnBar/SettingsWindow.swift", "utf8"),
    ]);

    expect(model).toContain("settings.claudeLimitsEnabled");
    expect(model).toContain("settings.notificationsEnabled");
    expect(onboarding).toContain("Launch at login");
    expect(onboarding).toContain("Enable notifications");
    expect(onboarding).toContain("Enable Claude limits");
    expect(onboarding).toContain("Codex limits are read locally");
    expect(onboarding).toContain('HStack(spacing: 8) {\n                BurnFlame');
    expect(onboarding).toContain('LazyVGrid(columns: [GridItem(.adaptive(minimum: 120)');
    expect(onboarding).toContain('alignment: .leading, spacing: 8) {\n                ForEach(tools');
    expect(settings).toContain("Claude limits access");
    expect(settings).toContain("Notification permission");
  });
});

describe("native leaderboard sync contract", () => {
  test("sync is explicit, immediate, and visible instead of silently stale", async () => {
    const [model, popover, settings] = await Promise.all([
      readFile("Sources/BurnBar/AppModel.swift", "utf8"),
      readFile("Sources/BurnBar/PopoverView.swift", "utf8"),
      readFile("Sources/BurnBar/SettingsWindow.swift", "utf8"),
    ]);

    expect(settings).toContain("model.setLeaderboardSyncEnabled");
    expect(model).toContain("func syncLeaderboardNow() async");
    expect(model).toContain("p.terminationHandler");
    expect(model).toContain("await refreshLeaderboard()");
    expect(model).toContain("refreshLeaderboardAfterSync");
    const pollLoop = model.slice(model.indexOf("pollTask = Task"), model.indexOf("statusTask = Task"));
    expect(pollLoop).toContain("await self?.refreshRemote()");
    expect(pollLoop).not.toContain("syncLeaderboardNow");
    expect(popover).toContain('Text("Sync now")');
    expect(popover).toContain('Text("sync off")');
    expect(popover).toContain('Text("synced")');
    expect(popover).not.toContain('Text("live")');
  });
});
