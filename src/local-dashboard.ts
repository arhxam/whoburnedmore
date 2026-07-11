import { entryTotalTokens, type DailyUsageEntry } from "./shared.js";
import { formatTokens, formatUSD } from "./output.js";

/**
 * The "get on the leaderboard" CTA baked into the local page. The old version
 * form-POSTed the whole payload to the website's /connect route to mint an
 * anonymous dashboard — that ingestion path is retired (submission requires
 * sign-in), and the data is already ON this machine, so the honest handoff is:
 * run `npx whoburnedmore` (no flag), which signs you in and submits the same
 * usage through the authenticated path. Nothing leaves the machine from this
 * page itself.
 */
export interface ConnectOptions {
  /** The web app origin, e.g. https://whoburnedmore.com (for the profile link). */
  webBaseUrl: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface Agg {
  tokens: number;
  cost: number;
}

/**
 * Render a fully self-contained dark dashboard for the given usage entries.
 * No network, no external assets — everything (styles, data, charts) is inline,
 * so the file works opened directly from disk. Used by `whoburnedmore --local`.
 */
export function renderDashboardHtml(
  entries: DailyUsageEntry[],
  generatedAt: Date = new Date(),
  connect?: ConnectOptions,
): string {
  const today = generatedAt.toISOString().slice(0, 10);
  const totals = {
    tokens: 0,
    cost: 0,
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
  };
  let todayTokens = 0;
  const byTool = new Map<string, Agg>();
  const byModel = new Map<string, Agg>();
  const byDate = new Map<string, number>();

  for (const e of entries) {
    const tokens = entryTotalTokens(e);
    totals.tokens += tokens;
    totals.cost += e.costUSD;
    totals.input += e.inputTokens;
    totals.output += e.outputTokens;
    totals.cacheWrite += e.cacheCreationTokens;
    totals.cacheRead += e.cacheReadTokens;
    if (e.date === today) todayTokens += tokens;

    const t = byTool.get(e.tool) ?? { tokens: 0, cost: 0 };
    t.tokens += tokens;
    t.cost += e.costUSD;
    byTool.set(e.tool, t);

    const m = byModel.get(e.model) ?? { tokens: 0, cost: 0 };
    m.tokens += tokens;
    m.cost += e.costUSD;
    byModel.set(e.model, m);

    byDate.set(e.date, (byDate.get(e.date) ?? 0) + tokens);
  }

  const activeDays = byDate.size;
  const avgPerDay = activeDays > 0 ? totals.tokens / activeDays : 0;

  // Last 60 calendar days as a bar chart, oldest first.
  const days: Array<{ date: string; tokens: number }> = [];
  for (let i = 59; i >= 0; i--) {
    const d = new Date(generatedAt.getTime() - i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    days.push({ date: d, tokens: byDate.get(d) ?? 0 });
  }
  const maxDay = Math.max(1, ...days.map((d) => d.tokens));
  const bars = days
    .map((d) => {
      const h = Math.round((d.tokens / maxDay) * 100);
      return `<div class="bar" style="height:${Math.max(d.tokens > 0 ? 2 : 0, h)}%" title="${d.date}: ${esc(formatTokens(d.tokens))} tokens"></div>`;
    })
    .join("");

  const toolRows = [...byTool.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(
      ([tool, a]) =>
        `<tr><td>${esc(tool)}</td><td class="num">${esc(formatTokens(a.tokens))}</td><td class="num">${esc(formatUSD(a.cost))}</td></tr>`,
    )
    .join("");

  const modelRows = [...byModel.entries()]
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .slice(0, 12)
    .map(
      ([model, a]) =>
        `<tr><td class="mono">${esc(model)}</td><td class="num">${esc(formatTokens(a.tokens))}</td><td class="num">${esc(formatUSD(a.cost))}</td></tr>`,
    )
    .join("");

  // Compact label/value row for the left rail (mirrors the web dashboard's RailStat).
  const railRow = (label: string, value: string, accent = false) =>
    `<div class="rrow"><span class="rlabel">${esc(label)}</span><span class="rval${accent ? " accent" : ""}">${esc(value)}</span></div>`;

  // Token-breakdown proportion bar + cells (input / output / cache write / read).
  const tb = [
    { label: "input", value: totals.input, color: "#3b82f6" },
    { label: "output", value: totals.output, color: "#22c55e" },
    { label: "cache write", value: totals.cacheWrite, color: "#a855f7" },
    { label: "cache read", value: totals.cacheRead, color: "#ea580c" },
  ];
  const tbSum = tb.reduce((a, p) => a + p.value, 0) || 1;
  const tbBar = tb
    .map((p) => `<div style="width:${(p.value / tbSum) * 100}%;background:${p.color}"></div>`)
    .join("");
  const tbCells = tb
    .map(
      (p) =>
        `<div class="tbcell"><div class="tblabel"><span class="dot" style="background:${p.color}"></span>${p.label}</div><div class="tbval">${esc(formatTokens(p.value))}</div><div class="tbpct">${Math.round((p.value / tbSum) * 100)}%</div></div>`,
    )
    .join("");

  // Leaderboard CTA: this page is offline by design, so the handoff is the
  // command itself — a plain run signs you in and submits this same local data
  // through the authenticated path. No payload ever leaves via this page.
  const connectCta = connect
    ? `
    <div class="connect">
      <div class="connect-row">
        <div>
          <div class="connect-title">Claim your spot on the public leaderboard</div>
          <div class="connect-sub">Run the command below in your terminal — it signs you in and puts these numbers on <a href="${esc(connect.webBaseUrl)}">whoburnedmore.com</a> under your handle. Nothing has left your machine yet.</div>
        </div>
        <code class="connect-cmd">npx whoburnedmore</code>
      </div>
      <div class="connect-note">Only daily totals are submitted — never your prompts or code. Background sync keeps your page fresh afterwards.</div>
    </div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>your burn — whoburnedmore (local)</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: #0c0a09; color: #fafaf9;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.5;
  }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 40px 20px 80px; }
  h1 { font-size: 22px; margin: 0; line-height: 1.2; }
  h1 .q { color: #ea580c; }
  .sub { color: #a8a29e; font-size: 13px; margin-top: 4px; }
  .mono, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .head { display: flex; align-items: center; gap: 14px; margin-bottom: 22px; }
  .flame { width: 46px; height: 46px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; border-radius: 12px; border: 1px solid #292524; background: #1c1917; font-size: 22px; }

  /* Split layout: narrow sticky rail + wide scrolling column (mirrors the web). */
  .layout { display: grid; gap: 24px; align-items: start; }
  @media (min-width: 900px) { .layout { grid-template-columns: 280px minmax(0, 1fr); } .rail { position: sticky; top: 20px; } }
  .rail { display: flex; flex-direction: column; gap: 16px; }
  .rail-card { background: #1c1917; border: 1px solid #292524; border-radius: 14px; padding: 16px; }
  .hero-val { font-size: 30px; font-weight: 800; font-family: ui-monospace, monospace; color: #4ade80; font-variant-numeric: tabular-nums; line-height: 1.1; margin-top: 2px; }
  .rdiv { height: 1px; background: #292524; margin: 12px 0; }
  .rrow { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding: 5px 0; }
  .rlabel { font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: #a8a29e; }
  .rval { font-family: ui-monospace, monospace; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .rval.accent { color: #4ade80; }
  .col { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
  .panel { background: #1c1917; border: 1px solid #292524; border-radius: 14px; padding: 18px 20px; }
  .panel h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: #d6d3d1; margin: 0 0 14px; }
  .tbbar { display: flex; height: 12px; width: 100%; border-radius: 999px; overflow: hidden; background: #292524; }
  .tbgrid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 14px; }
  @media (min-width: 520px) { .tbgrid { grid-template-columns: repeat(4, 1fr); } }
  .tbcell { border: 1px solid #292524; background: #0c0a09; border-radius: 10px; padding: 8px 10px; }
  .tblabel { display: flex; align-items: center; gap: 6px; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #a8a29e; }
  .dot { width: 8px; height: 8px; border-radius: 999px; display: inline-block; flex-shrink: 0; }
  .tbval { font-family: ui-monospace, monospace; font-weight: 700; font-size: 16px; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .tbpct { font-size: 11px; color: #a8a29e; }
  .chart { display: flex; align-items: flex-end; gap: 2px; height: 140px; }
  .bar { flex: 1; background: linear-gradient(to top, #ea580c, #f97316); border-radius: 2px 2px 0 0; min-height: 0; transition: opacity .15s; }
  .bar:hover { opacity: .7; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid #292524; }
  th { color: #a8a29e; font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
  td.num { text-align: right; font-family: ui-monospace, monospace; font-variant-numeric: tabular-nums; }
  td.mono { font-family: ui-monospace, monospace; font-size: 12px; }
  .foot { color: #78716c; font-size: 12px; margin-top: 32px; }
  .foot code { color: #d6d3d1; }
  .connect { display: block; margin: 24px 0 4px; background: linear-gradient(135deg, rgba(234,88,12,.16), rgba(249,115,22,.06)); border: 1px solid rgba(234,88,12,.5); border-radius: 14px; padding: 18px 20px; }
  .connect-row { display: flex; flex-direction: column; gap: 14px; align-items: flex-start; }
  @media (min-width: 640px) { .connect-row { flex-direction: row; align-items: center; justify-content: space-between; } }
  .connect-title { font-size: 16px; font-weight: 700; }
  .connect-sub { color: #d6d3d1; font-size: 13px; margin-top: 4px; max-width: 60ch; }
  .connect-cmd { flex-shrink: 0; display: inline-block; border-radius: 10px; background: rgba(0,0,0,.35); border: 1px solid rgba(234,88,12,.5); color: #fed7aa; font-size: 14px; font-weight: 600; padding: 11px 18px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; user-select: all; }
  .connect-sub a { color: #fed7aa; }
  .connect-note { color: #a8a29e; font-size: 12px; margin-top: 14px; padding-top: 12px; border-top: 1px solid rgba(234,88,12,.25); }
  .connect-note code { color: #fed7aa; background: rgba(0,0,0,.25); padding: 1px 6px; border-radius: 5px; }
</style>
</head>
<body>
  <div class="wrap">
    <header class="head">
      <div class="flame">🔥</div>
      <div>
        <h1>your local burn</h1>
        <div class="sub">generated ${esc(generatedAt.toISOString().slice(0, 16).replace("T", " "))} · nothing left your machine</div>
      </div>
    </header>
${connectCta}
    <div class="layout">
      <aside class="rail">
        <div class="rail-card">
          <div class="rlabel">total tokens</div>
          <div class="hero-val">${esc(formatTokens(totals.tokens))}</div>
          <div class="rdiv"></div>
          ${railRow("avg / day", formatTokens(avgPerDay), true)}
          ${railRow("est. cost", formatUSD(totals.cost))}
          ${railRow("active days", String(activeDays))}
          ${railRow("today", formatTokens(todayTokens))}
        </div>
      </aside>

      <div class="col">
        <div class="panel">
          <h2>daily burn (last 60 days)</h2>
          <div class="chart">${bars}</div>
        </div>

        <div class="panel">
          <h2>by tool</h2>
          <table>
            <thead><tr><th>tool</th><th class="num">tokens</th><th class="num">est. cost</th></tr></thead>
            <tbody>${toolRows || '<tr><td colspan="3">no usage found</td></tr>'}</tbody>
          </table>
        </div>

        <div class="panel">
          <h2>by model</h2>
          <table>
            <thead><tr><th>model</th><th class="num">tokens</th><th class="num">est. cost</th></tr></thead>
            <tbody>${modelRows || '<tr><td colspan="3">no usage found</td></tr>'}</tbody>
          </table>
        </div>

        <div class="panel">
          <h2>token breakdown</h2>
          <div class="tbbar">${tbBar}</div>
          <div class="tbgrid">${tbCells}</div>
        </div>
      </div>
    </div>

    <div class="foot">
      Re-run <code>npx whoburnedmore --local</code> to refresh this page.<br>
      ${connect ? "Use “Connect your account” above to save it to whoburnedmore.com and join the leaderboard." : "Run <code>npx whoburnedmore</code> (no flag) to get a shareable dashboard at whoburnedmore.com — no sign-in."}
    </div>
  </div>
</body>
</html>
`;
}
