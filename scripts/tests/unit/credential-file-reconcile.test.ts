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
// no filesystem, no socket.
//
// Cost class `unit` (docs/architecture.md §3 L1). Parsing, loading and the
// refusal taxonomy live in credential-file.test.ts.
import { describe, expect, test } from "bun:test";
import {
  CredentialFileRefusal,
  reconcileRoster,
  type ParticipantKind,
  type RosterEntry,
  type RunningParticipant,
} from "../../lib/swarm/credential-file.ts";
import type { PersonaIdentity } from "../../lib/swarm/persona-keys.ts";

const identity = (seed: string): PersonaIdentity => ({
  publicKeyB64: `pub-${seed}`,
  privateJwk: { kty: "OKP", crv: "Ed25519", x: `pub-${seed}`, d: `priv-${seed}` },
});

const entry = (name: string, kind: ParticipantKind = "agent"): RosterEntry => ({
  name,
  kind,
  identity: identity(`${kind}-${name}`),
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
    expect(plan.start[0]?.identity).toEqual(identity("agent-athena"));
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
