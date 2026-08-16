import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("native daily leaderboard contract", () => {
  test("fetches and labels a live today-only leaderboard", async () => {
    const [client, popover, model, app, island] = await Promise.all([
      readFile("Sources/BurnBar/WbmClient.swift", "utf8"),
      readFile("Sources/BurnBar/PopoverView.swift", "utf8"),
      readFile("Sources/BurnBar/AppModel.swift", "utf8"),
      readFile("Sources/BurnBar/BurnBarApp.swift", "utf8"),
      readFile("Sources/BurnBar/IslandWindowController.swift", "utf8"),
    ]);

    expect(client).toContain("period=today&by=tokens");
    expect(client).not.toContain("period=all&by=tokens");
    expect(client).toContain("dailyLeader: board.dailyLeader");
    expect(popover).toContain("Today’s leaderboard");
    expect(popover).toContain('Text("synced")');
    expect(popover).toContain("Formatters.compactTokens(row.todayTokens)");
    expect(popover).toContain("not ranked today");
    expect(popover).not.toContain("all-time tokens");
    expect(popover).not.toContain("today's highest");
    expect(model).toContain("settings.limitsRefreshSeconds");
    expect(model).toContain("await self?.refreshRemote()");
    expect(app).toContain("IslandWindowController(");
    expect(island).toContain("case .expanded:");
    expect(island).toContain("Task { await model.refreshRemote() }");
    const islandSurface = await readFile("Sources/BurnBar/IslandSurfaceView.swift", "utf8");
    expect(islandSurface).toContain('sectionLabel("Today’s leaderboard")');
    expect(islandSurface).toContain("profile.leaderboardContext");
    expect(islandSurface).toContain("profile.dailyLeader");
    expect(islandSurface).toContain('Text("Your rank")');
    expect(islandSurface).toContain("Text(Formatters.compactTokens(day.tokens))");
    expect(islandSurface).not.toContain('sectionLabel("Today by tool")');
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
    const syncLoop = model.slice(
      model.indexOf("syncTask = Task"),
      model.indexOf("private func fetchClaudeIfEnabled"),
    );
    expect(syncLoop.indexOf("Task.sleep")).toBeGreaterThanOrEqual(0);
    expect(syncLoop.indexOf("Task.sleep")).toBeLessThan(syncLoop.indexOf("maybeSync"));
    expect(model).toContain("Task { await syncLeaderboardNow() }");
    expect(model).toContain("private var activeSyncProcess: Process?");
    expect(model).toContain("guard activeSyncProcess === p else { return }");
    const stopMethod = model.slice(model.indexOf("func stop()"), model.indexOf("// MARK: refresh paths"));
    expect(stopMethod).toContain("activeSyncProcess?.terminate()");
    expect(popover).toContain('Text("Sync now")');
    expect(popover).toContain('Text("sync off")');
    expect(popover).toContain('Text("synced")');
    expect(popover).not.toContain('Text("live")');
  });
});

describe("local app bundle data integrity", () => {
  test("uses clear, non-duplicative overview metrics", async () => {
    const [island, settings, popover] = await Promise.all([
      readFile("Sources/BurnBar/IslandSurfaceView.swift", "utf8"),
      readFile("Sources/BurnBar/SettingsWindow.swift", "utf8"),
      readFile("Sources/BurnBar/PopoverView.swift", "utf8"),
    ]);
    expect(island).not.toContain('label: "Tightest"');
    expect(island).not.toContain('detail: "usage limit"');
    expect(island).toContain('label: "Last 7 days"');
    expect(island).toContain('label: "Streak"');
    expect(island).toContain("model.streakDays");
    expect(island).toContain('return "start today"');
    expect(island).toContain('return "active days"');
    expect(settings).toContain('("tightest", "Highest usage (auto)")');
    expect(settings).not.toContain('"Tightest window (auto)"');
    expect(popover).toContain('? "highest usage" : "primary"');
  });

  test("refuses to assemble without the replay-safe ccusage executable", async () => {
    const build = await readFile("scripts/build-app.sh", "utf8");
    expect(build).toContain('ERROR: standalone ccusage');
    expect(build).not.toContain('WARN: standalone ccusage');
  });

  test("never labels a 14-day fallback as today's tools", async () => {
    const popover = await readFile("Sources/BurnBar/PopoverView.swift", "utf8");
    expect(popover).not.toContain("s.byToolToday.isEmpty ? s.byTool14d : s.byToolToday");
  });

  test("stays dormant at launch until hover or a menu-bar click", async () => {
    const app = await readFile("Sources/BurnBar/BurnBarApp.swift", "utf8");
    expect(app).not.toContain('else if env["BURNBAR_ISLAND_AUTOPEN"] != "0"');
  });

  test("settles AppKit layout before the explicit local expanded launch", async () => {
    const app = await readFile("Sources/BurnBar/BurnBarApp.swift", "utf8");
    expect(app).toContain('if shouldOpenExpanded {\n            DispatchQueue.main.asyncAfter');
    expect(app).toContain('CommandLine.arguments.contains("--expanded")');
  });

  test("supports a deterministic compact-reveal integration launch", async () => {
    const [app, island] = await Promise.all([
      readFile("Sources/BurnBar/BurnBarApp.swift", "utf8"),
      readFile("Sources/BurnBar/IslandWindowController.swift", "utf8"),
    ]);
    expect(app).toContain('env["BURNBAR_ISLAND_REVEALED"] == "1"');
    expect(app).toContain("island?.reveal()");
    expect(island).toContain("func reveal(on screen: NSScreen? = nil)");
  });

  test("renders the exact website icon inside the island", async () => {
    const [project, island] = await Promise.all([
      readFile("project.yml", "utf8"),
      readFile("Sources/BurnBar/IslandSurfaceView.swift", "utf8"),
    ]);
    expect(project).toContain("../web/src/app/apple-icon.png");
    expect(island).toContain("BurnBarBrandIcon.image");
    expect(island).not.toContain("Image(nsImage: NSApplication.shared.applicationIconImage)");
  });

  test("detects notch hover without Accessibility permission", async () => {
    const island = await readFile("Sources/BurnBar/IslandWindowController.swift", "utf8");
    expect(island).toContain("PointerSamplingPolicy.interval");
    expect(island).toContain("Timer(timeInterval:");
    expect(island).toContain("RunLoop.main.add(timer, forMode: .common)");
    expect(island).toContain("NSEvent.mouseLocation");
    expect(island).toContain("if presentation.state == .revealed, compactPanel.frame.contains(point)");
    expect(island).toContain("localClickMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown)");
    expect(island).toContain("NSEvent.pressedMouseButtons");
  });

  test("animates expansion, honors Reduce Motion, and scrolls on short displays", async () => {
    const [controller, surface] = await Promise.all([
      readFile("Sources/BurnBar/IslandWindowController.swift", "utf8"),
      readFile("Sources/BurnBar/IslandSurfaceView.swift", "utf8"),
    ]);

    expect(controller).toContain("animateExpansion");
    expect(controller).toContain("accessibilityDisplayShouldReduceMotion");
    expect(controller).toContain("CATransform3DMakeScale");
    expect(surface).toContain("accessibilityReduceMotion");
    expect(surface).toContain("ScrollView");
    expect(surface).toContain(".animation(");
  });
});
