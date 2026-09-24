// Desired-state reconciliation as a PURE function
// (scripts/lib/swarm/credential-file.ts `reconcileRoster`,
// smoke-production-spec.md §6.1, issue #1026 W3.1).
//
// The rule, in the spec's own words: "A run makes the running participants
// equal the file: named ones are started or kept, unnamed running ones are
// stopped." Three disjoint sets, so the caller's execution order is explicit
// and testable rather than implied by a diff routine somebody reads once.
//
// WHY PURE MATTERS HERE. The §10 W3 gates — "roster change with overlapping
// containers: one take", and the spoof-keys generation sweep of §6.4 step (3)
// — have to be drivable with a FABRICATED running set and no Docker daemon.
// Every case below is exactly that: plain records in, a plan out, no clock,
// no filesystem, no socket. The one exception is the closing ratchet, which
// reads source to keep boot code on `planParticipants`: the composition that
// never maps an unconfigured path to the empty roster.
//
// Cost class `unit` (docs/architecture.md §3 L1). Parsing, loading and the
// refusal taxonomy live in credential-file.test.ts.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  CredentialFileRefusal,
  planParticipants,
  reconcileRoster,
  type CredentialEntry,
  type CredentialFile,
  type ParticipantKind,
  type RosterEntry,
  type RunningParticipant,
} from "../../lib/swarm/credential-file.ts";

const identity = (seed: string): CredentialEntry => ({
  memberId: `m-${seed}`,
  publicKeyB64: `pub-${seed}`,
  privateJwk: { kty: "OKP", crv: "Ed25519", x: `pub-${seed}`, d: `priv-${seed}` },
  bearer: `tok-${seed}`,
  modelKey: `zen-${seed}`,
});

const entry = (name: string, kind: ParticipantKind = "agent"): RosterEntry => ({
  name,
  kind,
  credential: identity(`${kind}-${name}`),
});

const running = (
  name: string,
  over: { kind?: ParticipantKind; generation?: string } = {},
): RunningParticipant => ({
  name,
  kind: over.kind ?? "agent",
  containerName: `rm_prod_participant_${over.kind ?? "agent"}_${name}`,
  ...(over.generation === undefined ? {} : { generation: over.generation }),
});

const names = (xs: readonly { name: string }[]) => xs.map((x) => x.name).sort();
const tagged = (xs: readonly { name: string; kind: ParticipantKind }[]) =>
  xs.map((x) => `${x.kind}:${x.name}`).sort();

// ── THE THREE SETS ─────────────────────────────────────────────────────────
describe("reconcileRoster — named-and-running is kept, named-and-not is started, unnamed-and-running is stopped", () => {
  test("a participant on the roster AND running is KEPT — never restarted for its own sake", () => {
    const plan = reconcileRoster([entry("athena")], [running("athena")]);
    expect(names(plan.keep)).toEqual(["athena"]);
    expect(plan.start).toEqual([]);
    expect(plan.stop).toEqual([]);
  });

  test("a participant on the roster and NOT running is STARTED, carrying its own key", () => {
    const plan = reconcileRoster([entry("athena")], []);
    expect(names(plan.start)).toEqual(["athena"]);
    expect(plan.start[0]?.credential).toEqual(identity("agent-athena"));
    expect(plan.keep).toEqual([]);
    expect(plan.stop).toEqual([]);
  });

  test("a participant RUNNING and not on the roster is STOPPED, by container name", () => {
    const plan = reconcileRoster([], [running("boreas")]);
    expect(names(plan.stop)).toEqual(["boreas"]);
    expect(plan.stop[0]?.containerName).toBe("rm_prod_participant_agent_boreas");
    expect(plan.start).toEqual([]);
    expect(plan.keep).toEqual([]);
  });

  test("the three sets are DISJOINT — nothing is both kept and stopped", () => {
    const plan = reconcileRoster(
      [entry("athena"), entry("noop-analyst"), entry("themis", "judge")],
      [running("athena"), running("boreas")],
    );
    const keepNames = new Set(names(plan.keep));
    for (const s of plan.stop) expect(keepNames.has(s.name)).toBe(false);
    for (const s of plan.start) expect(keepNames.has(s.name)).toBe(false);
  });

  test("an empty roster against nothing running is an empty plan", () => {
    expect(reconcileRoster([], [])).toEqual({ start: [], keep: [], stop: [] });
  });

  test("the EXPLICIT empty roster stops everyone — the one documented way to do it", () => {
    const plan = reconcileRoster([], [running("athena"), running("themis", { kind: "judge" })]);
    expect(names(plan.stop)).toEqual(["athena", "themis"]);
    expect(plan.start).toEqual([]);
    expect(plan.keep).toEqual([]);
  });
});

// ── A ROSTER CHANGE PRODUCES THE RIGHT START/STOP SETS ─────────────────────
describe("reconcileRoster — a roster change resolves into exactly one start set and one stop set", () => {
  test("{athena,boreas} running, roster now {boreas,cygnus}: start cygnus, keep boreas, stop athena", () => {
    const plan = reconcileRoster(
      [entry("boreas"), entry("cygnus")],
      [running("athena"), running("boreas")],
    );
    expect(names(plan.start)).toEqual(["cygnus"]);
    expect(names(plan.keep)).toEqual(["boreas"]);
    expect(names(plan.stop)).toEqual(["athena"]);
  });

  test("the production roster booting onto a bare host starts all four, stops nothing", () => {
    const plan = reconcileRoster(
      [entry("athena"), entry("noop-analyst"), entry("robot-money"), entry("themis", "judge")],
      [],
    );
    expect(tagged(plan.start)).toEqual([
      "agent:athena",
      "agent:noop-analyst",
      "agent:robot-money",
      "judge:themis",
    ]);
    expect(plan.stop).toEqual([]);
  });

  test("an unchanged roster against a fully-running host is a NO-OP plan", () => {
    const roster = [entry("athena"), entry("robot-money"), entry("themis", "judge")];
    const live = [running("athena"), running("robot-money"), running("themis", { kind: "judge" })];
    const plan = reconcileRoster(roster, live);
    expect(plan.start).toEqual([]);
    expect(plan.stop).toEqual([]);
    expect(tagged(plan.keep)).toEqual(["agent:athena", "agent:robot-money", "judge:themis"]);
  });
});

// ── THE TWO NAMESPACES ARE NOT ONE ─────────────────────────────────────────
describe("reconcileRoster — an agent named X and a judge named X are different participants", () => {
  test("a running AGENT themis does not satisfy a roster that names a JUDGE themis", () => {
    const plan = reconcileRoster([entry("themis", "judge")], [running("themis", { kind: "agent" })]);
    expect(tagged(plan.start)).toEqual(["judge:themis"]);
    expect(tagged(plan.stop)).toEqual(["agent:themis"]);
    expect(plan.keep).toEqual([]);
  });

  test("a roster naming BOTH keeps both when both run", () => {
    const plan = reconcileRoster(
      [entry("themis", "agent"), entry("themis", "judge")],
      [running("themis", { kind: "agent" }), running("themis", { kind: "judge" })],
    );
    expect(tagged(plan.keep)).toEqual(["agent:themis", "judge:themis"]);
    expect(plan.start).toEqual([]);
    expect(plan.stop).toEqual([]);
  });

  test("dropping only the agent half stops the agent and leaves the judge alone", () => {
    const plan = reconcileRoster(
      [entry("themis", "judge")],
      [running("themis", { kind: "agent" }), running("themis", { kind: "judge" })],
    );
    expect(tagged(plan.stop)).toEqual(["agent:themis"]);
    expect(tagged(plan.keep)).toEqual(["judge:themis"]);
    expect(plan.start).toEqual([]);
  });
});

// ── SPOOF-KEYS GENERATION SWEEP (spec §6.4 step 3), expressed here ─────────
describe("reconcileRoster — a container on a SUPERSEDED generation is replaced even though it is on the roster", () => {
  test("an older generation is stopped AND restarted, not kept", () => {
    const plan = reconcileRoster([entry("athena")], [running("athena", { generation: "gen-1" })], "gen-2");
    expect(names(plan.stop)).toEqual(["athena"]);
    expect(names(plan.start)).toEqual(["athena"]);
    expect(plan.keep).toEqual([]);
  });

  test("a container already on the CURRENT generation is left alone — a rerun does not churn healthy containers", () => {
    const plan = reconcileRoster([entry("athena")], [running("athena", { generation: "gen-2" })], "gen-2");
    expect(names(plan.keep)).toEqual(["athena"]);
    expect(plan.start).toEqual([]);
    expect(plan.stop).toEqual([]);
  });

  test("a container with NO generation is superseded once a generation is current", () => {
    const plan = reconcileRoster([entry("athena")], [running("athena")], "gen-2");
    expect(names(plan.stop)).toEqual(["athena"]);
    expect(names(plan.start)).toEqual(["athena"]);
  });

  test("with NO current generation, a plain credential-file container is kept", () => {
    const plan = reconcileRoster([entry("athena")], [running("athena")]);
    expect(names(plan.keep)).toEqual(["athena"]);
  });

  test("the sweep is per-participant: only the stale one is replaced", () => {
    const plan = reconcileRoster(
      [entry("athena"), entry("robot-money")],
      [running("athena", { generation: "gen-1" }), running("robot-money", { generation: "gen-2" })],
      "gen-2",
    );
    expect(names(plan.stop)).toEqual(["athena"]);
    expect(names(plan.start)).toEqual(["athena"]);
    expect(names(plan.keep)).toEqual(["robot-money"]);
  });
});

// ── "NO PATH CONFIGURED" IS NOT "EMPTY ROSTER" ─────────────────────────────
describe("reconcileRoster — `null` desired means unconfigured, and that is not an instruction", () => {
  test("unconfigured with nothing running proceeds with no participants", () => {
    expect(reconcileRoster(null, [])).toEqual({ start: [], keep: [], stop: [] });
  });

  test("unconfigured WITH participants running refuses and names them", () => {
    let thrown: unknown;
    try {
      reconcileRoster(null, [running("athena"), running("themis", { kind: "judge" })]);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CredentialFileRefusal);
    const r = thrown as CredentialFileRefusal;
    expect(r.reason).toBe("unconfigured-with-running");
    expect(names(r.running)).toEqual(["athena", "themis"]);
    expect(r.message).toContain("athena");
    expect(r.message).toContain("themis");
  });

  test("`null` and `[]` differ: the empty roster stops everyone, unconfigured refuses", () => {
    const live = [running("athena")];
    expect(names(reconcileRoster([], live).stop)).toEqual(["athena"]);
    expect(() => reconcileRoster(null, live)).toThrow(CredentialFileRefusal);
  });
});

// ── THE ONE COMPOSITION A BOOT CALLS ───────────────────────────────────────
// The bug this block exists for is in a CALLER, not in `reconcileRoster`: a
// boot that writes `configured ? rosterEntries(load(path)) : []` maps "no path
// configured" to the empty roster, which stops every participant on the host.
// Every pure case above passes with that caller in place. `planParticipants`
// is the mapping, written once; the ratchet at the end keeps boot code from
// writing its own.
describe("planParticipants — resolution → load → reconcile, with unconfigured never read as empty", () => {
  const FILE: CredentialFile = {
    agents: { athena: identity("agent-athena") },
    judges: { themis: identity("judge-themis") },
  };

  /** A loader that records every call, so a test can prove it was never made. */
  function recordingLoader(result: CredentialFile | Error = FILE) {
    const calls: string[] = [];
    const load = (path: string): CredentialFile => {
      calls.push(path);
      if (result instanceof Error) throw result;
      return result;
    };
    return { calls, load };
  }

  test("unconfigured WITH participants running throws `unconfigured-with-running` and never calls load", () => {
    const loader = recordingLoader();
    let thrown: unknown;
    try {
      planParticipants({ configured: false }, [running("athena"), running("themis", { kind: "judge" })], loader.load);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CredentialFileRefusal);
    expect((thrown as CredentialFileRefusal).reason).toBe("unconfigured-with-running");
    expect(names((thrown as CredentialFileRefusal).running)).toEqual(["athena", "themis"]);
    expect(loader.calls).toEqual([]);
  });

  test("unconfigured with nothing running is an EMPTY plan, and load is still never called", () => {
    const loader = recordingLoader();
    expect(planParticipants({ configured: false }, [], loader.load)).toEqual({ start: [], keep: [], stop: [] });
    expect(loader.calls).toEqual([]);
  });

  test("the empty-roster caller bug is exactly what this refuses: [] would have stopped everyone", () => {
    // The buggy composition, spelled out, against the same inputs.
    const live = [running("athena"), running("themis", { kind: "judge" })];
    const buggy = reconcileRoster([], live);
    expect(names(buggy.stop)).toEqual(["athena", "themis"]);
    // The real one refuses and stops nobody.
    expect(() => planParticipants({ configured: false }, live, recordingLoader().load)).toThrow(CredentialFileRefusal);
  });

  test("a configured path is loaded ONCE, by that path, and reconciled against what runs", () => {
    const loader = recordingLoader();
    const plan = planParticipants(
      { configured: true, path: "/etc/rm/credential.json", origin: "env" },
      [running("athena"), running("boreas")],
      loader.load,
    );
    expect(loader.calls).toEqual(["/etc/rm/credential.json"]);
    expect(tagged(plan.keep)).toEqual(["agent:athena"]);
    expect(tagged(plan.start)).toEqual(["judge:themis"]);
    expect(names(plan.stop)).toEqual(["boreas"]);
  });

  test("a load refusal keeps its reason and names the setting that pointed at the path", () => {
    const missing = new CredentialFileRefusal("missing", "credential file /etc/rm/credential.json does not exist", {
      path: "/etc/rm/credential.json",
    });
    const viaEnv = recordingLoader(missing);
    let thrown: unknown;
    try {
      planParticipants({ configured: true, path: "/etc/rm/credential.json", origin: "env" }, [running("athena")], viaEnv.load);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as CredentialFileRefusal).reason).toBe("missing");
    expect((thrown as CredentialFileRefusal).message).toContain("RM_CREDENTIALS");
    expect(() =>
      planParticipants({ configured: true, path: "/x.json", origin: "flag" }, [], recordingLoader(missing).load),
    ).toThrow(/--credentials/);
  });

  test("the spoof-keys generation is passed through: a superseded container is replaced", () => {
    const plan = planParticipants(
      { configured: true, path: "/etc/rm/credential.json", origin: "flag" },
      [running("athena", { generation: "gen-1" })],
      recordingLoader({ agents: { athena: identity("agent-athena") }, judges: {} }).load,
      "gen-2",
    );
    expect(names(plan.stop)).toEqual(["athena"]);
    expect(names(plan.start)).toEqual(["athena"]);
  });

  test("RATCHET: outside credential-file.ts, no production code calls reconcileRoster directly", () => {
    // A boot that calls `reconcileRoster` itself chooses its own mapping for an
    // unconfigured path — the bug above. Boot code calls `planParticipants`.
    const repo = join(import.meta.dir, "..", "..", "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "tests" || name.startsWith(".")) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(ts|js|mjs)$/.test(name)) continue;
        const rel = relative(repo, path);
        if (rel === join("scripts", "lib", "swarm", "credential-file.ts")) continue;
        if (/\breconcileRoster\s*\(/.test(readFileSync(path, "utf8"))) offenders.push(rel);
      }
    };
    walk(join(repo, "scripts"));
    expect(offenders).toEqual([]);
  });
});

// ── PURITY ─────────────────────────────────────────────────────────────────
describe("reconcileRoster — pure: same inputs, same plan, inputs unmodified", () => {
  test("calling it twice yields an equal plan", () => {
    const roster = [entry("athena"), entry("themis", "judge")];
    const live = [running("boreas"), running("athena")];
    expect(reconcileRoster(roster, live)).toEqual(reconcileRoster(roster, live));
  });

  test("neither input array is mutated", () => {
    const roster = [entry("athena"), entry("cygnus")];
    const live = [running("athena"), running("boreas")];
    const rosterBefore = JSON.stringify(roster);
    const liveBefore = JSON.stringify(live);
    reconcileRoster(roster, live);
    expect(JSON.stringify(roster)).toBe(rosterBefore);
    expect(JSON.stringify(live)).toBe(liveBefore);
  });
});
