// Unit tests for the label-driven container reaper (scripts/lib/demo-reap.ts) —
// the sweep that closes the third gap behind e2e run 30406428674: nothing ever
// reaped a PRIOR run's orphans, so any leak was permanent and this host
// accumulated containers up to four days old.
//
// Everything here runs against an INJECTED fake docker runner over synthetic
// `docker ps` / `docker network ls` / `docker volume ls` fixtures. No daemon, no
// network — which matters more than usual for this subject: the host these tests
// run on is simultaneously the self-hosted runner AND the box serving
// stage.robotmoney-labs.dev, so a test that touched a real daemon to prove a
// reaper is safe could take the live site down proving it.
//
// The guard tests are the load-bearing half. A reaper whose age filter works but
// whose guards silently stopped applying is strictly worse than no reaper, so
// each guard has BOTH a "refuses to act" case and a "still acts when the guard
// does not apply" case — otherwise a guard that always fires would look green.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPOSE_PROJECT_LABEL,
  executeReap,
  formatAge,
  listLabeledContainers,
  listProjectNetworks,
  parseContainerLine,
  parseDockerTimestamp,
  parseDuration,
  planReap,
  readActiveProjects,
  type ReapContainer,
} from "../../lib/demo-reap.ts";
import { ENV_CLASS_LABEL } from "../../stack/naming.ts";
import type { DockerRunner } from "../../lib/demo-volumes.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");
const NOW = new Date("2026-07-29T12:00:00Z");
const SIX_HOURS = 6 * 3_600_000;

// ── Fixtures ────────────────────────────────────────────────────────────────

// One line of `docker ps -a --format json`, with Labels as the flat
// comma-joined string docker actually emits.
function psLine(o: {
  id: string;
  name: string;
  project?: string | null;
  envClass?: string | null;
  envHash?: string;
  created?: string;
  state?: string;
  status?: string;
  ports?: string;
}): string {
  const labels: string[] = [];
  if (o.project !== null) labels.push(`robotmoney.demo.project=${o.project ?? "p"}`);
  if (o.envClass !== null) labels.push(`robotmoney.env=${o.envClass ?? "ci"}`);
  labels.push(`robotmoney.env.hash=${o.envHash ?? "aaaaaaaaaa"}`);
  return JSON.stringify({
    ID: o.id,
    Names: o.name,
    Labels: labels.join(","),
    CreatedAt: o.created ?? "2026-07-25 02:19:17 +0000 UTC",
    State: o.state ?? "exited",
    Status: o.status ?? "Exited (137) 4 days ago",
    Ports: o.ports ?? "",
  });
}

// A container object straight to planReap, bypassing the docker line format.
function container(o: Partial<ReapContainer> & { id: string; name: string }): ReapContainer {
  return {
    project: "rm_ci_stack_1",
    envClass: "ci",
    envHash: "aaaaaaaaaa",
    createdAt: new Date("2026-07-25T02:19:17Z"),
    createdRaw: "2026-07-25 02:19:17 +0000 UTC",
    running: false,
    healthy: false,
    publishesHostPort: false,
    status: "Exited (137) 4 days ago",
    ...o,
  };
}

function fakeRunner(opts: {
  containers?: string[];
  networks?: Record<string, string[]>;
  volumes?: string[];
  psExit?: number;
  failRm?: Set<string>;
} = {}): { run: DockerRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: DockerRunner = (args) => {
    calls.push(args);
    if (args[0] === "ps") {
      const exitCode = opts.psExit ?? 0;
      if (exitCode !== 0) return { exitCode, stdout: "", stderr: "Cannot connect to the Docker daemon" };
      return { exitCode: 0, stdout: (opts.containers ?? []).join("\n") + "\n", stderr: "" };
    }
    if (args[0] === "network" && args[1] === "ls") {
      const f = args.find((a) => a.startsWith(`label=${COMPOSE_PROJECT_LABEL}=`)) ?? "";
      const project = f.slice(`label=${COMPOSE_PROJECT_LABEL}=`.length);
      return { exitCode: 0, stdout: ((opts.networks ?? {})[project] ?? []).join("\n") + "\n", stderr: "" };
    }
    if (args[0] === "network" && args[1] === "rm") return { exitCode: 0, stdout: "", stderr: "" };
    if (args[0] === "volume" && args[1] === "ls") {
      return { exitCode: 0, stdout: (opts.volumes ?? []).join("\n") + "\n", stderr: "" };
    }
    if (args[0] === "volume" && args[1] === "rm") return { exitCode: 0, stdout: "", stderr: "" };
    if (args[0] === "rm") {
      const id = args[args.length - 1]!;
      if (opts.failRm?.has(id)) return { exitCode: 1, stdout: "", stderr: `Error response from daemon: cannot remove ${id}` };
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

// ── Parsers ─────────────────────────────────────────────────────────────────

describe("parseDockerTimestamp", () => {
  test("accepts the `docker ps --format json` shape", () => {
    expect(parseDockerTimestamp("2026-07-25 02:19:17 +0000 UTC")?.toISOString()).toBe("2026-07-25T02:19:17.000Z");
  });
  test("accepts RFC3339Nano (`docker inspect .Created`)", () => {
    expect(parseDockerTimestamp("2026-07-25T02:19:17.123456789Z")?.toISOString()).toBe("2026-07-25T02:19:17.123Z");
  });
  test("applies a non-UTC offset rather than ignoring it", () => {
    expect(parseDockerTimestamp("2026-07-25 04:19:17 +0200 CEST")?.toISOString()).toBe("2026-07-25T02:19:17.000Z");
  });
  test("a zone-less stamp is UNKNOWN, never assumed UTC — guessing an age is how a reaper deletes the wrong thing", () => {
    expect(parseDockerTimestamp("2026-07-25 02:19:17")).toBeNull();
  });
  test("garbage and empty are null", () => {
    expect(parseDockerTimestamp("recently")).toBeNull();
    expect(parseDockerTimestamp("")).toBeNull();
  });
});

describe("parseDuration", () => {
  test("parses each supported unit", () => {
    expect(parseDuration("30s")).toBe(30_000);
    expect(parseDuration("90m")).toBe(5_400_000);
    expect(parseDuration("6h")).toBe(SIX_HOURS);
    expect(parseDuration("2d")).toBe(172_800_000);
  });
  test("THROWS on anything else — a typo must never silently become 0 (= reap everything)", () => {
    for (const bad of ["", "6", "6 h", "abc", "-1h", "6hh", "1.5h"]) {
      expect(() => parseDuration(bad)).toThrow(/invalid duration/);
    }
  });
  test("formatAge is human and lossy-but-honest", () => {
    expect(formatAge(30_000)).toBe("30s");
    expect(formatAge(SIX_HOURS)).toBe("6.0h");
    expect(formatAge(4 * 86_400_000)).toBe("4.0d");
  });
});

describe("parseContainerLine", () => {
  test("pulls id, name, all three labels, running/healthy/published-port out of one row", () => {
    const c = parseContainerLine(psLine({
      id: "676c43de5091",
      name: "rm_ci_stack_30406428674_1-api-1",
      project: "rm_ci_stack_30406428674_1",
      envClass: "ci",
      envHash: "9f2a1c4b7d",
      state: "running",
      status: "Up 4 days (healthy)",
      ports: "0.0.0.0:48787->8787/tcp",
    }))!;
    expect(c.id).toBe("676c43de5091");
    expect(c.project).toBe("rm_ci_stack_30406428674_1");
    expect(c.envClass).toBe("ci");
    expect(c.envHash).toBe("9f2a1c4b7d");
    expect(c.running).toBe(true);
    expect(c.healthy).toBe(true);
    expect(c.publishesHostPort).toBe(true);
    expect(c.createdAt?.toISOString()).toBe("2026-07-25T02:19:17.000Z");
  });

  test("falls back to Status when docker is too old to emit State — a lost `running` would make the live guard vacuous", () => {
    const line = JSON.stringify({ ID: "x", Names: "n", Labels: "robotmoney.env=local", CreatedAt: "2026-07-25 02:19:17 +0000 UTC", Status: "Up 2 hours" });
    expect(parseContainerLine(line)!.running).toBe(true);
  });

  test("blank and non-JSON lines are ignored", () => {
    expect(parseContainerLine("  ")).toBeNull();
    expect(parseContainerLine("not json")).toBeNull();
  });
});

// ── Label selection ─────────────────────────────────────────────────────────

describe("listLabeledContainers — selection is by LABEL, never by name substring", () => {
  test("a class scope becomes --filter label=robotmoney.env=<class>", () => {
    const { run, calls } = fakeRunner({ containers: [psLine({ id: "a", name: "rm_ci_stack_1-api-1" })] });
    const found = listLabeledContainers(run, "ci");
    expect(found.map((c) => c.name)).toEqual(["rm_ci_stack_1-api-1"]);
    expect(calls[0]).toEqual(["ps", "-a", "--filter", `label=${ENV_CLASS_LABEL}=ci`, "--format", "json"]);
    // The whole safety story: nothing in the argv is a name pattern.
    for (const a of calls[0]!) expect(a).not.toContain("rm_ci");
    for (const a of calls[0]!) expect(a).not.toContain("name=");
  });

  test("`all` filters on label PRESENCE, so an unlabelled container is never even a candidate", () => {
    const { run, calls } = fakeRunner({ containers: [] });
    listLabeledContainers(run, "all");
    expect(calls[0]).toEqual(["ps", "-a", "--filter", `label=${ENV_CLASS_LABEL}`, "--format", "json"]);
  });

  test("a dead daemon THROWS — a silent empty list reads exactly like 'no leaks'", () => {
    const { run } = fakeRunner({ psExit: 1 });
    expect(() => listLabeledContainers(run, "ci")).toThrow(/docker ps failed/);
  });
});

// ── Age filtering ───────────────────────────────────────────────────────────

describe("planReap — age threshold", () => {
  test("only containers OLDER than the threshold are reaped", () => {
    const old = container({ id: "old", name: "rm_ci_stack_old-api-1", project: "rm_ci_stack_old", createdAt: new Date("2026-07-25T02:19:17Z") });
    const young = container({ id: "young", name: "rm_ci_stack_young-api-1", project: "rm_ci_stack_young", createdAt: new Date("2026-07-29T11:00:00Z") });
    const plan = planReap([old, young], { now: NOW, olderThanMs: SIX_HOURS });
    expect(plan.doomed.map((c) => c.id)).toEqual(["old"]);
    expect(plan.verdicts.find((v) => v.container.id === "young")!.reason).toMatch(/younger than the threshold/);
    expect(plan.doomedProjects).toEqual(["rm_ci_stack_old"]);
  });

  test("exactly-at-threshold counts as old; one millisecond under does not", () => {
    const at = container({ id: "at", name: "at", project: "pa", createdAt: new Date(NOW.getTime() - SIX_HOURS) });
    const under = container({ id: "under", name: "under", project: "pu", createdAt: new Date(NOW.getTime() - SIX_HOURS + 1) });
    const plan = planReap([at, under], { now: NOW, olderThanMs: SIX_HOURS });
    expect(plan.doomed.map((c) => c.id)).toEqual(["at"]);
  });

  test("an unparseable creation time is KEPT with a loud reason — never guessed", () => {
    const unknown = container({ id: "u", name: "u", project: "pu", createdAt: null, createdRaw: "recently" });
    const plan = planReap([unknown], { now: NOW, olderThanMs: SIX_HOURS });
    expect(plan.doomed).toEqual([]);
    expect(plan.verdicts[0]!.reason).toMatch(/unknown age/);
  });

  test("every candidate gets a verdict with a reason — kept ones are as loud as removed ones", () => {
    const cs = [
      container({ id: "a", name: "a", project: "pa" }),
      container({ id: "b", name: "b", project: "pb", createdAt: NOW }),
    ];
    const plan = planReap(cs, { now: NOW, olderThanMs: SIX_HOURS });
    expect(plan.verdicts).toHaveLength(2);
    for (const v of plan.verdicts) expect(v.reason.length).toBeGreaterThan(10);
  });
});

// ── Guards ──────────────────────────────────────────────────────────────────

describe("planReap — G1 the active demo project is never touched", () => {
  const ancient = new Date("2026-07-01T00:00:00Z");

  test("refuses the project named by .agents/demo-state.json, however old", () => {
    const cs = [
      container({ id: "api", name: "rm_demo_stack_live-api-1", project: "rm_demo_stack_live", envClass: "local", createdAt: ancient }),
      container({ id: "pg", name: "rm_demo_stack_live-postgres-1", project: "rm_demo_stack_live", envClass: "local", createdAt: ancient }),
    ];
    const plan = planReap(cs, { now: NOW, olderThanMs: SIX_HOURS, activeProjects: ["rm_demo_stack_live"] });
    expect(plan.doomed).toEqual([]);
    // The guard protects the WHOLE project, not just the container that matched.
    for (const v of plan.verdicts) expect(v.reason).toMatch(/G1 active demo project/);
  });

  test("but a DIFFERENT old project in the same sweep is still reaped (the guard is not a blanket no-op)", () => {
    const cs = [
      container({ id: "live", name: "live-api-1", project: "rm_demo_stack_live", envClass: "local", createdAt: ancient, running: true }),
      container({ id: "stale", name: "stale-api-1", project: "rm_demo_stack_stale", envClass: "local", createdAt: ancient }),
    ];
    const plan = planReap(cs, { now: NOW, olderThanMs: SIX_HOURS, activeProjects: ["rm_demo_stack_live"] });
    expect(plan.doomed.map((c) => c.id)).toEqual(["stale"]);
  });
});

describe("planReap — G2 a live, serving project is never touched even when the state file disagrees", () => {
  const ancient = new Date("2026-07-01T00:00:00Z");

  test("a healthcheck-healthy local project survives with NO active-project entry at all (the state file was stale on this host)", () => {
    const cs = [
      container({ id: "api", name: "rm_demo_stack_serving-api-1", project: "rm_demo_stack_serving", envClass: "local", createdAt: ancient, running: true, healthy: true, status: "Up 4 days (healthy)" }),
      container({ id: "pg", name: "rm_demo_stack_serving-postgres-1", project: "rm_demo_stack_serving", envClass: "local", createdAt: ancient }),
    ];
    // activeProjects deliberately names a DEAD project — exactly the stale-state
    // -file situation observed on 2026-07-29.
    const plan = planReap(cs, { now: NOW, olderThanMs: SIX_HOURS, activeProjects: ["rm_demo_stack_dead"] });
    expect(plan.doomed).toEqual([]);
    for (const v of plan.verdicts) expect(v.reason).toMatch(/G2 project is live and serving/);
  });

  test("publishing a host port counts as serving even without a healthcheck", () => {
    const cs = [container({ id: "api", name: "rm_demo_stack_p-api-1", project: "rm_demo_stack_p", envClass: "local", createdAt: ancient, running: true, publishesHostPort: true, status: "Up 4 days" })];
    const plan = planReap(cs, { now: NOW, olderThanMs: SIX_HOURS });
    expect(plan.doomed).toEqual([]);
    expect(plan.verdicts[0]!.reason).toMatch(/publishing a host port/);
  });

  test("a STOPPED old local project is still reaped — G2 protects the serving, not the merely present", () => {
    const cs = [container({ id: "x", name: "rm_demo_stack_dead-api-1", project: "rm_demo_stack_dead", envClass: "local", createdAt: ancient, running: false })];
    const plan = planReap(cs, { now: NOW, olderThanMs: SIX_HOURS });
    expect(plan.doomed.map((c) => c.id)).toEqual(["x"]);
  });

  test("G2 does NOT shield a CI container — a healthy `robotmoney.env=ci` stack past the threshold IS the leak (run 30406428674)", () => {
    // The exact incident shape: the cancelled run's api container, still up,
    // still healthy, still holding :48787, four days later. Refusing to reap it
    // because it looks healthy is what let it hold the port for an hour.
    const cs = [container({
      id: "676c43de5091",
      name: "rm_ci_stack_30406428674_1-api-1",
      project: "rm_ci_stack_30406428674_1",
      envClass: "ci",
      createdAt: ancient,
      running: true,
      healthy: true,
      publishesHostPort: true,
      status: "Up 4 days (healthy)",
    })];
    const plan = planReap(cs, { now: NOW, olderThanMs: SIX_HOURS });
    expect(plan.doomed.map((c) => c.id)).toEqual(["676c43de5091"]);
    expect(plan.verdicts[0]!.reason).toMatch(/STILL RUNNING/);
  });

  test("…but G1 still outranks everything: the active project is safe even if it is CI-labelled", () => {
    const cs = [container({ id: "a", name: "a", project: "rm_ci_stack_self", envClass: "ci", createdAt: ancient })];
    const plan = planReap(cs, { now: NOW, olderThanMs: SIX_HOURS, activeProjects: ["rm_ci_stack_self"] });
    expect(plan.doomed).toEqual([]);
  });
});

describe("planReap — G3 a job never reaps its own environment", () => {
  test("containers carrying this job's env hash are kept regardless of apparent age", () => {
    const cs = [
      container({ id: "mine", name: "rm_ci_stack_mine-api-1", project: "rm_ci_stack_mine", envHash: "9f2a1c4b7d", createdAt: new Date("2026-07-01T00:00:00Z") }),
      container({ id: "theirs", name: "rm_ci_stack_theirs-api-1", project: "rm_ci_stack_theirs", envHash: "0000000000", createdAt: new Date("2026-07-01T00:00:00Z") }),
    ];
    const plan = planReap(cs, { now: NOW, olderThanMs: SIX_HOURS, selfEnvHash: "9f2a1c4b7d" });
    expect(plan.doomed.map((c) => c.id)).toEqual(["theirs"]);
    expect(plan.verdicts[0]!.reason).toMatch(/G3 this job's own environment/);
  });
});

// ── The active-project input ────────────────────────────────────────────────

describe("readActiveProjects", () => {
  test("reads the project out of a real state file", () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-reap-state-"));
    try {
      const f = join(dir, "demo-state.json");
      writeFileSync(f, JSON.stringify({ project: "rm_demo_stack_ab12", apiPort: 48787 }));
      const r = readActiveProjects(f);
      expect(r.projects).toEqual(["rm_demo_stack_ab12"]);
      expect(r.note).toContain("G1 protects project=rm_demo_stack_ab12");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a missing file yields an empty list and SAYS SO — G1 silently protecting nothing is the failure mode", () => {
    const r = readActiveProjects(join(tmpdir(), "definitely-absent-demo-state.json"));
    expect(r.projects).toEqual([]);
    expect(r.note).toMatch(/has nothing to protect/);
  });

  test("a malformed file warns instead of throwing (G2 still stands)", () => {
    const dir = mkdtempSync(join(tmpdir(), "demo-reap-state-"));
    try {
      const f = join(dir, "demo-state.json");
      writeFileSync(f, "{not json");
      const r = readActiveProjects(f);
      expect(r.projects).toEqual([]);
      expect(r.note).toMatch(/^WARNING:/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Execution ───────────────────────────────────────────────────────────────

describe("executeReap", () => {
  const doomedPlan = () =>
    planReap([container({ id: "cid1", name: "rm_ci_stack_old-api-1", project: "rm_ci_stack_old" })], { now: NOW, olderThanMs: SIX_HOURS });

  test("removes containers, then their compose networks, then their now-unreferenced volumes — in that order", () => {
    const { run, calls } = fakeRunner({
      networks: { rm_ci_stack_old: ["rm_ci_stack_old_default"] },
      volumes: [JSON.stringify({ Name: "rm_ci_stack_old_pgdata", Labels: "robotmoney.demo=1,robotmoney.demo.project=rm_ci_stack_old" })],
    });
    const out = executeReap(run, doomedPlan());
    expect(out.removedContainers).toEqual(["rm_ci_stack_old-api-1"]);
    expect(out.removedNetworks).toEqual(["rm_ci_stack_old_default"]);
    expect(out.removedVolumes).toEqual(["rm_ci_stack_old_pgdata"]);

    const kinds = calls.map((c) => c.slice(0, 2).join(" "));
    expect(kinds.indexOf("rm -f")).toBeLessThan(kinds.indexOf("network rm"));
    expect(kinds.indexOf("network rm")).toBeLessThan(kinds.indexOf("volume rm"));
  });

  test("networks are found by compose's OWN project label, not by guessing `<project>_default`", () => {
    const { run, calls } = fakeRunner({ networks: { rm_ci_stack_old: ["some-explicitly-named-net"] } });
    executeReap(run, doomedPlan());
    const ls = calls.find((c) => c[0] === "network" && c[1] === "ls")!;
    expect(ls).toContain(`label=${COMPOSE_PROJECT_LABEL}=rm_ci_stack_old`);
    // Proof it did not fall back to a name guess.
    expect(listProjectNetworks(run, "rm_ci_stack_old")).toEqual(["some-explicitly-named-net"]);
  });

  test("volume reclamation stays scoped to the reaped project's label", () => {
    const { run, calls } = fakeRunner({ volumes: [] });
    executeReap(run, doomedPlan());
    const ls = calls.find((c) => c[0] === "volume" && c[1] === "ls")!;
    expect(ls).toContain("label=robotmoney.demo.project=rm_ci_stack_old");
  });

  test("a failed container removal is reported, never swallowed — an attempted-and-failed removal is a surviving leak", () => {
    const { run } = fakeRunner({ failRm: new Set(["cid1"]) });
    const out = executeReap(run, doomedPlan());
    expect(out.removedContainers).toEqual([]);
    expect(out.failedContainers).toHaveLength(1);
    expect(out.failedContainers[0]!.name).toBe("rm_ci_stack_old-api-1");
  });

  test("--dry-run mutates NOTHING while still reporting exactly what would go", () => {
    const { run, calls } = fakeRunner({
      networks: { rm_ci_stack_old: ["rm_ci_stack_old_default"] },
      volumes: [JSON.stringify({ Name: "rm_ci_stack_old_pgdata", Labels: "robotmoney.demo=1,robotmoney.demo.project=rm_ci_stack_old" })],
    });
    const out = executeReap(run, doomedPlan(), { dryRun: true });
    expect(out.dryRun).toBe(true);
    // Same answer as the real run above — a dry run that reports a different set
    // than it would remove is worse than no dry run.
    expect(out.removedContainers).toEqual(["rm_ci_stack_old-api-1"]);
    expect(out.removedNetworks).toEqual(["rm_ci_stack_old_default"]);
    expect(out.removedVolumes).toEqual(["rm_ci_stack_old_pgdata"]);
    // …and not one mutating call was made.
    const mutations = calls.filter((c) => c[0] === "rm" || (c[1] === "rm" && (c[0] === "network" || c[0] === "volume")));
    expect(mutations).toEqual([]);
    // The READ calls did run, which is what makes the plan real.
    expect(calls.some((c) => c[0] === "network" && c[1] === "ls")).toBe(true);
    expect(calls.some((c) => c[0] === "volume" && c[1] === "ls")).toBe(true);
  });

  test("an empty plan touches docker for nothing at all", () => {
    const { run, calls } = fakeRunner({});
    const out = executeReap(run, planReap([], { now: NOW, olderThanMs: SIX_HOURS }));
    expect(out.removedContainers).toEqual([]);
    expect(calls).toEqual([]);
  });
});

// ── Wiring guards ───────────────────────────────────────────────────────────
// The reaper and the fixed teardown only matter if they are actually WIRED into
// the workflows. None of that is reachable from a unit test any other way (each
// needs Docker and a runner), so it is asserted against the real files.
describe("the fix is wired into every workflow that boots a demo stack", () => {
  // Issue #373 retired swarm-opencode-nightly.yml — the same real-inference
  // admission e2e.yml already spends on a push to main, and e2e.yml now also
  // holds the nightly `schedule` that workflow used to. e2e.yml is the only
  // workflow left that boots a demo stack.
  const workflows = ["e2e.yml"];
  const workflow = (w: string) => readFileSync(join(repoRoot, ".github", "workflows", w), "utf8");

  test("every always() teardown brings the compose project DOWN before reclaiming volumes", () => {
    for (const w of workflows) {
      const text = workflow(w);
      // Scoped to THIS run's project — never a bare `docker compose down`, which
      // on this shared runner would take the standing stage demo with it.
      expect({ workflow: w, down: text.includes('docker compose -p "$DEMO_PROJECT" \\') }).toEqual({ workflow: w, down: true });
      expect({ workflow: w, flags: text.includes("down -v --remove-orphans") }).toEqual({ workflow: w, flags: true });
      // Ordering: compose down must precede the demo-clean verdict.
      const downAt = text.indexOf("down -v --remove-orphans");
      const cleanAt = text.indexOf("scripts/demo-clean.ts --project");
      expect({ workflow: w, ordered: downAt >= 0 && cleanAt > downAt }).toEqual({ workflow: w, ordered: true });
    }
  });

  test("every workflow reaps prior runs' CI leftovers, scoped to robotmoney.env=ci", () => {
    for (const w of workflows) {
      const text = workflow(w);
      expect({ workflow: w, reaps: text.includes("scripts/demo-reap.ts --env-class ci --older-than") }).toEqual({ workflow: w, reaps: true });
      // `--env-class local` in CI would put the standing stage demo in scope.
      expect({ workflow: w, local: text.includes("demo-reap.ts --env-class local") }).toEqual({ workflow: w, local: false });
    }
  });

  test("the reaper is a first-class package script (operators get `bun run demo:reap`)", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["demo:reap"]).toBe("bun scripts/demo-reap.ts");
  });

  test("the CI reap threshold is longer than the e2e job's own ceiling — otherwise one run could reap another's live stack", () => {
    const text = workflow("e2e.yml");
    const threshold = /demo-reap\.ts --env-class ci --older-than (\S+)/.exec(text)![1]!;
    const ceilingMinutes = Math.max(...[...text.matchAll(/timeout-minutes:\s*(\d+)/g)].map((m) => Number(m[1])));
    expect(parseDuration(threshold)).toBeGreaterThan(ceilingMinutes * 60_000);
  });
});
