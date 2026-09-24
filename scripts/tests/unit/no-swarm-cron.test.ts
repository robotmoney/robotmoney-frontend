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
  "backend/**/*.{ts,sql,json}",
  "scripts/**/*.{ts,sh,json}",
  "docker-compose*.yml",
  ".env.example",
  ".github/**/*.{yml,yaml}",
  "stacks/**/*.{yml,yaml}",
];

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
};

function sweep(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const pattern of SWEEP_GLOBS) {
    for (const rel of new Glob(pattern).scanSync({ cwd: REPO, dot: true })) {
      if (seen.has(rel)) continue;
      if (rel.includes("node_modules/")) continue;
      seen.add(rel);
      out.push({ file: rel, text: readFileSync(join(REPO, rel), "utf8") });
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
    expect(hits(/job_schedules[\s\S]{0,120}swarm/)).toEqual([]);
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
    expect(hits("smoke-schedule")).toEqual([]);
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
