// W4 part 3 — THE OLD SCHEDULING MECHANISM IS GONE (issue #1026).
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §12 and §10, and
// docs/technical/smoke-production-spec.md §6.3 ("There is nothing to enable …
// There are no schedule rows, no cron strings, no `next_run_at`, and no enable
// command").
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE IS A GREP, AND WHY THE GREP IS THE POINT
// ─────────────────────────────────────────────────────────────────────────────
//
// The audit that produced this criterion found the new machinery had been
// landing BESIDE the old one. Two schedulers in a repository is not a state a
// behavioural test notices: each passes its own suite, and the second one is
// discovered in production when it opens a session nobody asked for.
//
// So the gate is structural and it is over the SHIPPING trees — `backend`,
// `scripts`, `docker-compose*.yml`, `.env.example`, `.github`, `stacks` — and
// it names every remaining hit with a reason. `docs/` is deliberately outside
// the sweep: the specs describe what was removed and why, and a document
// recording a removal is not the removal failing.
//
// WHAT MUST SURVIVE IS ASSERTED TOO. The job queue and every non-swarm kind —
// vault, wallet, buyback, project, analytics, research — are load-bearing and
// share every mechanism the swarm lane used. A removal that took them with it
// would pass a pure absence test, so the second half of this file asserts they
// are still there.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";

const REPO = join(import.meta.dir, "..", "..", "..");

/** The trees the criterion names. */
const SWEEP_GLOBS = [
  "backend/*.{ts,sql,json}",
  "backend/**/*.{ts,sql,json}",
  // BOTH forms, because Bun's `**` does not match a path with no directory
  // component: `scripts/**/*.ts` misses `scripts/system-scheduler.ts`,
  // `scripts/smoke-live-smoke.ts` and `scripts/swarm-eval-local.ts` — three
  // top-level files that are exactly where a driver would keep a retired call.
  "scripts/*.{ts,sh,json}",
  "scripts/**/*.{ts,sh,json}",
  "docker-compose*.yml",
  ".env.example",
  ".github/**/*.{yml,yaml}",
  "stacks/**/*.{yml,yaml}",
  // Every workspace's package.json, by name. `bun run schedules:enable` was a
  // package script, so the manifests that declare scripts are where an enable
  // command would come back. `backend/package.json` is already matched by
  // `backend/*.{ts,sql,json}`; the other three live outside every glob above.
  "package.json",
  "frontend/package.json",
  "contract/package.json",
];

/** Every package.json that can declare a `bun run` script (root and the three
 *  workspaces). Named, not globbed, so a missing one is a failure rather than
 *  a quietly smaller sweep. */
const PACKAGE_MANIFESTS = ["package.json", "backend/package.json", "frontend/package.json", "contract/package.json"];

/**
 * Files whose remaining mention is REQUIRED, each with the reason.
 *
 * Kept tiny and explicit. A pinned set that grows is the smell this gate exists
 * to catch, so each entry says what it is and why it cannot be removed.
 */
const PINNED: Record<string, string> = {
  "backend/migrations/0072_drop_swarm_schedules.sql":
    "the migration that DELETES the rows has to name them",
  "scripts/tests/unit/no-swarm-cron.test.ts": "this gate",
  "scripts/tests/unit/swarm-session-window.test.ts":
    "it asserts the ABSENCE of `SWARM_WINDOW_MINUTES` from the session driver, so it has to name it",
};

/**
 * Strip comments before matching.
 *
 * The gate is about what the SYSTEM DOES, not about what a comment says it used
 * to do. Several surviving files explain the replacement by naming the thing
 * replaced — `scripts/system-scheduler.ts`'s header says it replaces
 * `worker-swarm`, migration 0040's header recalls where `swarm.judge` used to
 * run — and a gate that failed on those would be rewarded by deleting the
 * explanation, which is the wrong incentive.
 *
 * A string LITERAL is not a comment and is not stripped: a stale user-facing
 * description that still promises a `swarm.open_session` schedule is a real
 * finding, and one this sweep caught.
 */
function stripComments(file: string, text: string): string {
  if (file.endsWith(".sql")) return text.replace(/(^|\n)\s*--.*/g, "$1");
  if (file.endsWith(".yml") || file.endsWith(".yaml") || file.endsWith(".env.example") || file === ".env.example") {
    return text.replace(/(^|\n)\s*#.*/g, "$1");
  }
  if (file.endsWith(".ts") || file.endsWith(".json")) {
    return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\n)\s*\/\/.*/g, "$1");
  }
  if (file.endsWith(".sh")) return text.replace(/(^|\n)\s*#.*/g, "$1");
  return text;
}

function sweep(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const pattern of SWEEP_GLOBS) {
    for (const rel of new Glob(pattern).scanSync({ cwd: REPO, dot: true })) {
      if (seen.has(rel)) continue;
      if (rel.includes("node_modules/")) continue;
      seen.add(rel);
      out.push({ file: rel, text: stripComments(rel, readFileSync(join(REPO, rel), "utf8")) });
    }
  }
  return out;
}

const FILES = sweep();

function hits(needle: string | RegExp): string[] {
  const test_ = (t: string): boolean => (typeof needle === "string" ? t.includes(needle) : needle.test(t));
  return FILES.filter((f) => !(f.file in PINNED) && test_(f.text)).map((f) => f.file).sort();
}

describe("the sweep covers what it claims to", () => {
  test("it read a meaningful number of files from every named tree", () => {
    expect(FILES.length).toBeGreaterThan(300);
    for (const prefix of ["backend/", "scripts/", "docker-compose", ".env.example", ".github/", "stacks/"]) {
      expect({ prefix, found: FILES.some((f) => f.file.startsWith(prefix)) }).toEqual({ prefix, found: true });
    }
    // The top-level files the `**` form alone would miss. Named, because the
    // sweep silently missing a directory is the one failure a grep gate cannot
    // report on itself.
    for (const file of ["scripts/system-scheduler.ts", "scripts/smoke-live-smoke.ts", "scripts/swarm-eval-local.ts"]) {
      expect({ file, swept: FILES.some((f) => f.file === file) }).toEqual({ file, swept: true });
    }
  });
});

describe("the five swarm.* schedule kinds are gone", () => {
  // `swarm.judge` is NOT in this list: it was never a schedule row. It is
  // covered by no-inline-judge.test.ts, which removes it for a different
  // reason.
  const KINDS = [
    "swarm.open_session",
    "swarm.publish_brief",
    "swarm.close_window",
    "swarm.aggregate",
    "swarm.publish",
  ];
  for (const kind of KINDS) {
    test(`\`${kind}\` appears nowhere in the shipping trees`, () => {
      expect({ kind, hits: hits(kind) }).toEqual({ kind, hits: [] });
    });
  }

  test("nothing seeds a swarm schedule row", () => {
    expect(hits("seedSwarmSchedules")).toEqual([]);
    expect(hits("resolveSwarmSchedules")).toEqual([]);
    // The two places a row can be seeded, named rather than pattern-matched.
    // A proximity regex over `job_schedules` and `swarm` was tried first and
    // was worse than useless: it matched migration FILENAME lists
    // (`0034_job_schedules_catchup_policy.sql` beside
    // `0035_swarm_member_avatar_bytes.sql`) and protected-table lists, neither
    // of which seeds anything. A gate that fires on a filename teaches its
    // reader to ignore it.
    for (const file of ["backend/src/db/seed.ts", "backend/schema/bootstrap-data.sql"]) {
      const text = FILES.find((f) => f.file === file)?.text ?? "";
      expect({ file, swarmKinds: [...text.matchAll(/'swarm\.[a-z_]+'/g)].map((m) => m[0]) }).toEqual({
        file,
        swarmKinds: [],
      });
    }
  });
});

describe("the enable flag, the enable command and the cron variables are gone", () => {
  test("SWARM_SCHEDULES_ENABLED appears nowhere — it is defaulted to 1 in the production compose today", () => {
    expect(hits("SWARM_SCHEDULES_ENABLED")).toEqual([]);
  });

  test("no SWARM_*_CRON variable survives", () => {
    expect(hits(/SWARM_[A-Z_]+_CRON/)).toEqual([]);
  });

  test("SWARM_WINDOW_MINUTES is gone — the epoch duration is the whole schedule (§2.2)", () => {
    expect(hits("SWARM_WINDOW_MINUTES")).toEqual([]);
  });

  test("nothing enables a schedule: `schedules:enable` and its script are gone", () => {
    expect(hits("schedules:enable")).toEqual([]);
    expect(hits("schedules-enable")).toEqual([]);
  });

  test("every package.json is in the sweep, and no `scripts` block names or runs a schedule-enable command", () => {
    for (const file of PACKAGE_MANIFESTS) {
      expect({ file, swept: FILES.some((f) => f.file === file) }).toEqual({ file, swept: true });
      // Parsed, not grepped: the name of a script is a KEY and its command is a
      // VALUE, and both are checked — `"enable": "bun run scripts/schedules-enable.ts"`
      // would hide from a key-only check, a renamed key from a value-only one.
      const manifest = JSON.parse(readFileSync(join(REPO, file), "utf8")) as { scripts?: Record<string, string> };
      const offending = Object.entries(manifest.scripts ?? {})
        .filter(([name, command]) => /schedules?[:-]enable|SWARM_SCHEDULES_ENABLED/.test(`${name} ${command}`))
        .map(([name]) => name);
      expect({ file, offending }).toEqual({ file, offending: [] });
    }
  });
});

describe("the swarm lane and the worker-swarm service are gone", () => {
  test("`WORKER_LANE: swarm` and `WORKER_LANE=swarm` appear nowhere", () => {
    expect(hits(/WORKER_LANE\s*[:=]\s*["']?swarm/)).toEqual([]);
  });

  test("the lane table declares no swarm lane", () => {
    const lanes = readFileSync(join(REPO, "backend/src/worker/lanes.ts"), "utf8");
    expect(lanes).not.toMatch(/LaneName\s*=\s*[^;]*"swarm"/);
    expect(lanes).not.toContain('swarm: { name: "swarm"');
    expect(lanes).not.toContain("SWARM_KINDS");
  });

  test("no composition declares a `worker-swarm` service", () => {
    expect(hits("worker-swarm")).toEqual([]);
  });

  test("scripts/lib/smoke-schedule.ts is gone", () => {
    // The MODULE, by its path. Not the bare word: `--smoke-schedules` is a
    // surviving seed flag for the non-swarm fast-demo overlays, and a needle
    // that swept it up would be pressure to rename a thing that is fine.
    expect(hits("smoke-schedule.ts")).toEqual([]);
    expect(hits("lib/smoke-schedule")).toEqual([]);
    expect(hits('from "./smoke-schedule')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What must survive
// ─────────────────────────────────────────────────────────────────────────────

describe("the general job queue and every non-swarm kind are untouched", () => {
  const seed = readFileSync(join(REPO, "backend/src/db/seed.ts"), "utf8");
  const KEEP = [
    "vault.sample_share_price",
    "vault.sample_adapters",
    "wallet.sample_balances",
    "wallet.sample_sleeves",
    "buybacks.refresh",
    "ops.repair_gaps",
    "ops.backfill_asset_prices",
    "analytics.parity_sweep",
    "projects.discover",
    "projects.refresh_coins",
    "projects.refresh_wallets",
    "projects.fetch_vaults",
    "projects.snapshot_daily",
    "projects.sync_revenue",
    "projects.recompute_coverage",
    "regime.classify",
    "research.refresh",
  ];
  for (const kind of KEEP) {
    test(`\`${kind}\` is still seeded`, () => {
      expect({ kind, present: seed.includes(kind) }).toEqual({ kind, present: true });
    });
  }

  test("the job_schedules table, the tick and the claim loop are all still there", () => {
    expect(seed).toContain("job_schedules");
    const scheduler = readFileSync(join(REPO, "backend/src/worker/scheduler.ts"), "utf8");
    expect(scheduler).toContain("job_schedules");
  });

  test("the three surviving lanes are declared and resolve", () => {
    const lanes = readFileSync(join(REPO, "backend/src/worker/lanes.ts"), "utf8");
    for (const lane of ["analytics", "research", "generic"]) {
      expect({ lane, present: lanes.includes(`name: "${lane}"`) }).toEqual({ lane, present: true });
    }
  });

  test("the analytics and research worker services survive in the production compose", () => {
    const compose = readFileSync(join(REPO, "docker-compose.yml"), "utf8");
    expect(compose).toContain("worker-analytics:");
    expect(compose).toContain("worker-research:");
  });

  test("the production compose declares the system-scheduler that replaces worker-swarm (§1)", () => {
    const compose = readFileSync(join(REPO, "docker-compose.yml"), "utf8");
    expect(compose).toContain("system-scheduler:");
  });
});
