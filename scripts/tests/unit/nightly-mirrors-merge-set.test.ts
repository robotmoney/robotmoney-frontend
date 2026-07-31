// THE INVARIANT: nightly is isomorphic to the merge-to-main set (issue #373,
// docs/architecture.md §11.3 E6, docs/decisions.md D26).
//
// WHY THIS FILE IS THE MECHANISM, NOT A CONVENTION
// Before #373 the two sets were not merely different, they were FULLY DISJOINT:
// ten workflows carried `push: branches: [main]`, zero of the six nightlies
// did, and "nightly" was DEFINED as everything merge does not run. A red
// nightly therefore required reading — which suite was that, what are its pass
// semantics, is this a product regression or a provider outage — before anyone
// knew whether release code was broken. That interpretation cost was paid every
// time, by whoever was on call.
//
// With the sets equal, a red nightly means exactly one thing: the code on
// `main` — release code — is broken, by an input that changed while nobody was
// watching. Nothing else can produce it.
//
// The relationship has to be enforced MECHANICALLY or it silently drifts back
// apart: adding a workflow, or adding a schedule to one, is a one-line edit
// that nothing else in CI notices. So this test asserts the equality in BOTH
// directions and NAMES the workflows on one side only.
//
// Cost class: fast unit. Pure file reads + YAML parsing — no Docker, no
// network, no model, and nothing here can skip.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const workflowDir = join(repoRoot, ".github/workflows");

const workflowFiles = (): string[] => readdirSync(workflowDir).filter((n) => /\.ya?ml$/.test(n)).sort();
const read = (name: string): string => readFileSync(join(workflowDir, name), "utf8");

interface Workflow {
  on?: unknown;
  true?: unknown;
  jobs?: Record<string, { if?: string; steps?: { if?: string; run?: string; name?: string }[] }>;
}

/**
 * A workflow's `on:` mapping. YAML 1.1 folds the bare key `on` to boolean true;
 * Bun.YAML keeps it a string. Accept BOTH — a parser that quietly observed no
 * triggers at all would wave every workflow through this file.
 */
function triggers(name: string): Record<string, unknown> {
  const wf = Bun.YAML.parse(read(name)) as Workflow;
  const on = (wf.on ?? wf.true) as unknown;
  if (!on || typeof on !== "object" || Array.isArray(on)) {
    throw new Error(`${name}: could not read an \`on:\` mapping — refusing to treat that as "no triggers"`);
  }
  return on as Record<string, unknown>;
}

/** Does this workflow run on a push to the default branch? */
function pushesToMain(name: string): boolean {
  const push = triggers(name).push as { branches?: unknown } | undefined;
  if (!push || typeof push !== "object") return false;
  const branches = push.branches;
  return Array.isArray(branches) && branches.map(String).includes("main");
}

/** Does this workflow run on a cron schedule? */
function isScheduled(name: string): boolean {
  const schedule = triggers(name).schedule;
  return Array.isArray(schedule) && schedule.length > 0;
}

function cronsOf(name: string): string[] {
  const schedule = triggers(name).schedule;
  if (!Array.isArray(schedule)) return [];
  return schedule.map((e) => String((e as { cron?: unknown }).cron ?? ""));
}

describe("nightly is isomorphic to the merge-to-main set", () => {
  const files = workflowFiles();
  const pushSet = files.filter(pushesToMain);
  const scheduleSet = files.filter(isScheduled);

  test("the scan is non-vacuous — a walker regression cannot make this file green", () => {
    // A directory that stopped yielding workflows would make every equality
    // below trivially true (∅ === ∅).
    expect(files.length).toBeGreaterThan(5);
    expect(pushSet.length).toBeGreaterThan(5);
  });

  test("every workflow on `push: branches: [main]` also runs on a nightly schedule", () => {
    const missing = pushSet.filter((f) => !isScheduled(f));
    expect(
      missing,
      `these workflows run on a merge to main but have NO nightly schedule, so a merge signal exists that no nightly reproduces: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("every workflow with a `schedule:` also runs on `push: branches: [main]`", () => {
    const missing = scheduleSet.filter((f) => !pushesToMain(f));
    expect(
      missing,
      `these workflows run on a nightly schedule but NOT on a merge to main, so a red nightly on them needs required reading before anyone knows whether release code is broken: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  test("the two sets are equal, as sets", () => {
    expect(scheduleSet).toEqual(pushSet);
  });

  test("cron minutes are staggered — the mirrors must not all start at once", () => {
    const minutes = pushSet.flatMap((f) => cronsOf(f).map((c) => `${f}:${c.split(" ")[0]} ${c.split(" ")[1]}`));
    const stamps = pushSet.flatMap((f) => cronsOf(f).map((c) => c.split(" ").slice(0, 2).join(" ")));
    expect(new Set(stamps).size, `two mirrors share a cron start time: ${minutes.join(", ")}`).toBe(stamps.length);
  });

  test("every scheduled workflow declares exactly one cron entry", () => {
    for (const f of scheduleSet) expect({ workflow: f, crons: cronsOf(f).length }).toEqual({ workflow: f, crons: 1 });
  });
});

// ── The "no new suite" half (issue #373 AC 4) ───────────────────────────────
// Isomorphism is about the WORK, not merely the trigger list. A workflow that
// carries both triggers but gates a job or a step on `github.event_name ==
// 'schedule'` runs something on a nightly that a merge does not — which is
// exactly the disjointness this invariant exists to remove, re-introduced one
// step at a time and invisible to the trigger equality above.
//
// Reporting therefore has to RIDE on tests that already run (the e2e admission
// record is rendered from the admission e2e.yml already spends), never on a new
// suite stood up to produce a metric.
describe("nightly runs the merge set and nothing more", () => {
  const files = workflowFiles();

  // `!= 'schedule'` / `!= 'push'` are the OPPOSITE shape — they narrow work
  // AWAY from a trigger rather than adding schedule-only work — and are not
  // matched. Only a positive equality gate is.
  const SCHEDULE_ONLY_GATE = /github\.event_name\s*==\s*'schedule'/;

  test("no job or step is gated on `github.event_name == 'schedule'`", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const wf = Bun.YAML.parse(read(file)) as Workflow;
      for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
        if (job.if && SCHEDULE_ONLY_GATE.test(job.if)) offenders.push(`${file}: job ${jobName}`);
        for (const step of job.steps ?? []) {
          if (step.if && SCHEDULE_ONLY_GATE.test(step.if)) offenders.push(`${file}: job ${jobName} step ${JSON.stringify(step.name ?? step.run ?? "")}`);
        }
      }
    }
    expect(
      offenders,
      `these run only on a nightly and never on a merge, so the nightly stops being a mirror: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  // RED CONTROL. A guard that only ever runs against a clean tree is
  // indistinguishable from one whose regex matches nothing.
  test("red control: a schedule-only step gate IS matched", () => {
    expect(SCHEDULE_ONLY_GATE.test("github.event_name == 'schedule'")).toBe(true);
    expect(SCHEDULE_ONLY_GATE.test("always() && github.event_name == 'schedule'")).toBe(true);
    // …and the narrowing shapes are not.
    expect(SCHEDULE_ONLY_GATE.test("github.event_name != 'schedule'")).toBe(false);
    expect(SCHEDULE_ONLY_GATE.test("github.event_name != 'pull_request'")).toBe(false);
  });

  test("the retired nightlies are gone, not merely renamed", () => {
    // Both duplicated something the merge set already runs, so folding them in
    // would have run the same assertions twice per merge (docs/decisions.md
    // D26). Their disposition is retirement; this pins that they did not come
    // back on a schedule of their own.
    for (const gone of ["committee-opencode-nightly.yml", "demo-live-smoke-nightly.yml"]) {
      expect(files, `${gone} was retired by issue #373`).not.toContain(gone);
    }
  });
});
