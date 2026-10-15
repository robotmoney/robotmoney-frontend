// scripts/tests/unit/parity-sweep-schedule.test.ts — the daily parity sweep
// never overlaps data acquisition (issue 1375, owner requirement).
//
// The sweep (analytics.parity_sweep) runs once a day. Over seven days, no
// analytics-producer run, no projects job and no buybacks.refresh may fire
// within 15 minutes of it, under both producer cadences in use: the
// docker-compose default (regime 22:30, research 23:00) and production's
// 3-hourly cadence (regime :30, research :00 of every third hour).
//
// Every schedule is read from where it is declared: the job crons from
// backend/src/db/seed.ts SCHEDULES and migration 0123, the compose default from
// docker-compose.yml, and production's cadence from scripts/lib/smoke-cadence.ts
// (the realistic profile a production-shaped boot injects). A pure, small cron
// expander covers the forms these use; an unsupported form fails the test.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveSmokeCadence } from "../../lib/smoke-cadence.ts";

const root = join(import.meta.dir, "..", "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

const GAP_MS = 15 * 60_000;
const DAYS = 7;

/** One field of a 5-field cron: `*`, `*\/n`, `a`, `a-b`, `a-b/n`, and lists of those. */
function expandField(field: string, min: number, max: number): number[] {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`unsupported cron field ${JSON.stringify(field)}`);
    const step = m[2] ? Number(m[2]) : 1;
    const [lo, hi] = m[1] === "*" ? [min, max] : m[1]!.includes("-") ? m[1]!.split("-").map(Number) : [Number(m[1]), m[2] ? max : Number(m[1])];
    for (let v = lo!; v <= hi!; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** Every firing of a UTC cron in [start, start + days). Day-of-month, month and weekday must be `*`. */
function firings(cron: string, start: Date, days: number): number[] {
  const [minute, hour, dom, month, dow] = cron.trim().split(/\s+/);
  if ([dom, month, dow].some((f) => f !== "*")) throw new Error(`unsupported cron ${JSON.stringify(cron)}: only daily patterns`);
  const minutes = expandField(minute!, 0, 59);
  const hours = expandField(hour!, 0, 23);
  const out: number[] = [];
  for (let d = 0; d < days; d++) {
    for (const h of hours) for (const m of minutes) out.push(start.getTime() + d * 86_400_000 + h * 3_600_000 + m * 60_000);
  }
  return out;
}

/** db/seed.ts SCHEDULES, read as text (importing seed.ts opens the database). */
function seedSchedules(): { kind: string; cron: string }[] {
  const src = read("backend/src/db/seed.ts");
  const block = src.slice(src.indexOf("export const SCHEDULES"), src.indexOf("];", src.indexOf("export const SCHEDULES")));
  return [...block.matchAll(/\{\s*kind:\s*"([^"]+)",\s*cron:\s*"([^"]+)"[^\n]*?enabled:\s*(true|false)/g)]
    .filter((m) => m[3] === "true")
    .map((m) => ({ kind: m[1]!, cron: m[2]! }));
}

function composeProducerCrons(): string[] {
  const compose = read("docker-compose.yml");
  return ["PRODUCER_REGIME_CRON", "PRODUCER_RESEARCH_CRON"].map((name) => {
    const m = new RegExp(`${name}:\\s*\\$\\{${name}:-([^}]+)\\}`).exec(compose);
    if (!m) throw new Error(`docker-compose.yml declares no default for ${name}`);
    return m[1]!.trim();
  });
}

const START = new Date("2026-10-19T00:00:00Z");

const schedules = seedSchedules();
const sweep = schedules.filter((s) => s.kind === "analytics.parity_sweep");
const acquisition = schedules.filter((s) => s.kind.startsWith("projects.") || s.kind === "buybacks.refresh");

describe("the parity sweep's schedule (issue 1375)", () => {
  test("one seeded sweep, once a day at 04:47 UTC, and migration 0123 moves an existing row to the same cron", () => {
    expect(sweep).toEqual([{ kind: "analytics.parity_sweep", cron: "47 4 * * *" }]);
    expect(firings(sweep[0]!.cron, START, 1)).toHaveLength(1);
    const migration = read("backend/migrations/0123_analytics_parity_sweep_daily.sql");
    expect(migration).toContain("SET cron = '47 4 * * *'");
  });

  test("the acquisition jobs the rule names are all present, so the check is not vacuous", () => {
    const kinds = acquisition.map((s) => s.kind).sort();
    expect(kinds).toContain("buybacks.refresh");
    for (const k of ["projects.discover", "projects.refresh_coins", "projects.refresh_wallets", "projects.fetch_vaults", "projects.snapshot_daily", "projects.sync_revenue", "projects.recompute_coverage"]) {
      expect(kinds).toContain(k);
    }
  });

  const cadences: [string, string[]][] = [
    ["the docker-compose default", composeProducerCrons()],
    ["production's 3-hourly cadence", [resolveSmokeCadence({ cadence: "realistic" }).regimeCron, resolveSmokeCadence({ cadence: "realistic" }).researchCron]],
  ];

  test("the production cadence is the 3-hourly one this rule names", () => {
    expect(cadences[1]![1]).toEqual(["30 */3 * * *", "0 */3 * * *"]);
  });

  for (const [label, producerCrons] of cadences) {
    test(`no producer run, projects job or buybacks.refresh fires within 15 minutes of a sweep over ${DAYS} days, with ${label}`, () => {
      // One day before and after, so a firing just across the window edge counts.
      const from = new Date(START.getTime() - 86_400_000);
      const sweeps = firings(sweep[0]!.cron, START, DAYS);
      const others = [
        ...producerCrons.map((cron) => ({ kind: `producer ${cron}`, cron })),
        ...acquisition,
      ].flatMap((s) => firings(s.cron, from, DAYS + 2).map((at) => ({ kind: s.kind, at })));
      const clashes = sweeps.flatMap((t) =>
        others.filter((o) => Math.abs(o.at - t) < GAP_MS).map((o) => `${o.kind} at ${new Date(o.at).toISOString()} vs sweep ${new Date(t).toISOString()}`),
      );
      expect(sweeps).toHaveLength(DAYS);
      expect(clashes).toEqual([]);
    });
  }

  test("the check catches a clash: an hourly sweep at :20 meets projects.refresh_wallets at 04:20", () => {
    const sweeps = firings("20 * * * *", START, 1);
    const wallets = firings("20 */6 * * *", START, 1);
    expect(sweeps.some((t) => wallets.some((w) => Math.abs(w - t) < GAP_MS))).toBe(true);
  });
});
