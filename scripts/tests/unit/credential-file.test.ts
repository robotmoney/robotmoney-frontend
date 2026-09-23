// The credential file IS the roster — path resolution, parsing, loading and
// the refusal taxonomy (scripts/lib/swarm/credential-file.ts,
// smoke-production-spec.md §6.1, issue #1026 W3.1).
//
// THE GATE THESE EXIST FOR (spec §10 W3): "Configured credential file
// disappears while participants run: refuse, participants untouched." The
// tempting implementation — treat a missing file as an empty roster — stops
// every participant on the host the moment an NFS mount blips or a path typo
// lands. So the rules pinned here are:
//
//   1. `missing`, `unreadable`, `malformed` and `duplicate-name` are DISTINCT
//      reasons, because the operator action differs for each.
//   2. A missing file is never an instruction: the refusal happens BEFORE any
//      participant is stopped, and the only way to remove everyone is the
//      explicit empty roster `{ "agents": {}, "judges": {} }`.
//   3. Agents and judges are two namespaces: an agent named X and a judge
//      named X are different participants holding different keys, and neither
//      is a duplicate of the other.
//   4. `--credentials` beats `RM_CREDENTIALS`, and every refusal names which
//      setting pointed at the failing path.
//
// Cost class `unit` (docs/architecture.md §3 L1): bun plus a temp directory,
// no Docker and no network. Reconciliation — the pure desired-state half of
// §6.1 — is pinned by its cost-class sibling credential-file-reconcile.test.ts.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialFileRefusal,
  loadCredentialFile,
  parseCredentialFile,
  reconcileRoster,
  resolveCredentialPath,
  rosterEntries,
  rosterPlanLines,
  type CredentialFile,
  type RosterEntry,
  type RunningParticipant,
} from "../../lib/swarm/credential-file.ts";
import type { PersonaIdentity } from "../../lib/swarm/persona-keys.ts";

const identity = (seed: string): PersonaIdentity => ({
  publicKeyB64: `pub-${seed}`,
  privateJwk: { kty: "OKP", crv: "Ed25519", x: `pub-${seed}`, d: `priv-${seed}` },
});

const PROD_ROSTER: CredentialFile = {
  agents: {
    athena: identity("athena"),
    "noop-analyst": identity("noop-analyst"),
    "robot-money": identity("robot-money"),
  },
  judges: { themis: identity("themis") },
};

/** The refusal this module threw, or a failure naming what happened instead. */
function refusal(fn: () => unknown): CredentialFileRefusal {
  try {
    fn();
  } catch (err) {
    if (err instanceof CredentialFileRefusal) return err;
    throw err;
  }
  throw new Error("expected a CredentialFileRefusal; the call returned normally");
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rm-credential-file-"));
}

const running = (over: Partial<RunningParticipant> & { name: string }): RunningParticipant => ({
  name: over.name,
  kind: over.kind ?? "agent",
  containerName: over.containerName ?? `rm_participant_${over.name}`,
  ...(over.generation === undefined ? {} : { generation: over.generation }),
});

// ── PATH RESOLUTION: the arg overrides the environment (spec §6.1) ──────────
describe("resolveCredentialPath — --credentials beats RM_CREDENTIALS, and unconfigured is its own answer", () => {
  test("the flag wins over the environment, and the origin says so", () => {
    expect(resolveCredentialPath({ RM_CREDENTIALS: "/etc/rm/env.json" }, "/opt/rm/flag.json")).toEqual({
      configured: true,
      path: "/opt/rm/flag.json",
      origin: "flag",
    });
  });

  test("with no flag the environment is used, and the origin says env", () => {
    expect(resolveCredentialPath({ RM_CREDENTIALS: "/etc/rm/credential.json" })).toEqual({
      configured: true,
      path: "/etc/rm/credential.json",
      origin: "env",
    });
  });

  test("neither present is `configured: false` — a legitimate state, not a refusal", () => {
    expect(resolveCredentialPath({})).toEqual({ configured: false });
  });

  test("an EMPTY RM_CREDENTIALS is unconfigured, not a path", () => {
    expect(resolveCredentialPath({ RM_CREDENTIALS: "" })).toEqual({ configured: false });
    expect(resolveCredentialPath({ RM_CREDENTIALS: "   " })).toEqual({ configured: false });
  });

  test("an empty --credentials value REFUSES rather than falling back — the operator meant to point somewhere", () => {
    expect(refusal(() => resolveCredentialPath({ RM_CREDENTIALS: "/etc/rm/env.json" }, "")).reason).toBe("malformed");
    expect(refusal(() => resolveCredentialPath({}, "   ")).reason).toBe("malformed");
  });

  test("a nonexistent path still RESOLVES — existence is not this function's business (the plan prints it first)", () => {
    expect(resolveCredentialPath({}, "/nowhere/at/all.json")).toEqual({
      configured: true,
      path: "/nowhere/at/all.json",
      origin: "flag",
    });
  });
});

// ── PARSING: total, strict, and the two namespaces stay apart ───────────────
describe("parseCredentialFile — the spec §6.1 shape, validated in full", () => {
  test("the production roster parses into both namespaces with the keys intact", () => {
    const parsed = parseCredentialFile(JSON.stringify(PROD_ROSTER), "/etc/rm/credential.json");
    expect(Object.keys(parsed.agents).sort()).toEqual(["athena", "noop-analyst", "robot-money"]);
    expect(Object.keys(parsed.judges)).toEqual(["themis"]);
    expect(parsed.judges.themis).toEqual(identity("themis"));
  });

  test("the EXPLICIT empty roster parses — it is the only way to remove every participant", () => {
    expect(parseCredentialFile('{"agents":{},"judges":{}}', "/etc/rm/credential.json")).toEqual({
      agents: {},
      judges: {},
    });
  });

  test("zero agents with several judges is valid", () => {
    const text = JSON.stringify({ agents: {}, judges: { themis: identity("themis"), dike: identity("dike") } });
    const parsed = parseCredentialFile(text, "/etc/rm/credential.json");
    expect(Object.keys(parsed.agents)).toEqual([]);
    expect(Object.keys(parsed.judges).sort()).toEqual(["dike", "themis"]);
  });

  test("an agent named X and a judge named X are DIFFERENT participants, not a duplicate", () => {
    const text = JSON.stringify({
      agents: { themis: identity("themis-agent") },
      judges: { themis: identity("themis-judge") },
    });
    const parsed = parseCredentialFile(text, "/etc/rm/credential.json");
    expect(parsed.agents.themis?.publicKeyB64).toBe("pub-themis-agent");
    expect(parsed.judges.themis?.publicKeyB64).toBe("pub-themis-judge");
    // Distinct keys is the whole point: a judge's key is never handed to an agent.
    expect(parsed.agents.themis?.publicKeyB64).not.toBe(parsed.judges.themis?.publicKeyB64);
  });

  test("text that is not JSON is `malformed`", () => {
    expect(refusal(() => parseCredentialFile("not json at all", "/etc/rm/credential.json")).reason).toBe("malformed");
  });

  test("a missing `judges` namespace is `malformed` — both keys are required", () => {
    const r = refusal(() => parseCredentialFile('{"agents":{}}', "/etc/rm/credential.json"));
    expect(r.reason).toBe("malformed");
    expect(r.message).toContain("judges");
  });

  test("a missing `agents` namespace is `malformed`", () => {
    expect(refusal(() => parseCredentialFile('{"judges":{}}', "/etc/rm/credential.json")).reason).toBe("malformed");
  });

  test("an INVENTED top-level namespace refuses instead of being ignored", () => {
    // Silently dropping `observers` would run the host with fewer
    // participants than its own file says it has.
    const text = JSON.stringify({ agents: {}, judges: {}, observers: { argus: identity("argus") } });
    const r = refusal(() => parseCredentialFile(text, "/etc/rm/credential.json"));
    expect(r.reason).toBe("malformed");
    expect(r.message).toContain("observers");
  });

  test("a namespace that is not an object is `malformed`", () => {
    expect(refusal(() => parseCredentialFile('{"agents":[],"judges":{}}', "/etc/rm/credential.json")).reason).toBe("malformed");
    expect(refusal(() => parseCredentialFile('{"agents":{},"judges":null}', "/etc/rm/credential.json")).reason).toBe("malformed");
  });

  test("a JSON top level that is not an object is `malformed`", () => {
    expect(refusal(() => parseCredentialFile("[]", "/etc/rm/credential.json")).reason).toBe("malformed");
    expect(refusal(() => parseCredentialFile('"athena"', "/etc/rm/credential.json")).reason).toBe("malformed");
  });

  test("an entry missing `publicKeyB64` is `malformed` and the message names the entry", () => {
    const text = JSON.stringify({ agents: { athena: { privateJwk: { kty: "OKP" } } }, judges: {} });
    const r = refusal(() => parseCredentialFile(text, "/etc/rm/credential.json"));
    expect(r.reason).toBe("malformed");
    expect(r.message).toContain("athena");
  });

  test("an entry with an EMPTY `publicKeyB64` is `malformed` — present is not the same as usable", () => {
    const text = JSON.stringify({ agents: { athena: { publicKeyB64: "", privateJwk: { kty: "OKP" } } }, judges: {} });
    expect(refusal(() => parseCredentialFile(text, "/etc/rm/credential.json")).reason).toBe("malformed");
  });

  test("an entry missing `privateJwk` is `malformed` — a container cannot sign with a public key", () => {
    const text = JSON.stringify({ agents: {}, judges: { themis: { publicKeyB64: "pub-themis" } } });
    const r = refusal(() => parseCredentialFile(text, "/etc/rm/credential.json"));
    expect(r.reason).toBe("malformed");
    expect(r.message).toContain("themis");
  });

  test("an entry whose `privateJwk` is not an object is `malformed`", () => {
    const text = JSON.stringify({ agents: { athena: { publicKeyB64: "pub", privateJwk: "priv" } }, judges: {} });
    expect(refusal(() => parseCredentialFile(text, "/etc/rm/credential.json")).reason).toBe("malformed");
  });

  test("the same name twice in ONE namespace is `duplicate-name`, not last-wins", () => {
    // JSON.parse collapses a repeated key to the last value, which would hand
    // the container a key its operator did not intend. The file's TEXT is the
    // authority here.
    const text = '{"agents":{"athena":{"publicKeyB64":"pub-a","privateJwk":{"kty":"OKP"}},'
      + '"athena":{"publicKeyB64":"pub-b","privateJwk":{"kty":"OKP"}}},"judges":{}}';
    const r = refusal(() => parseCredentialFile(text, "/etc/rm/credential.json"));
    expect(r.reason).toBe("duplicate-name");
    expect(r.message).toContain("athena");
  });

  test("two spellings of one name in ONE namespace are `duplicate-name` after normalization", () => {
    const text = JSON.stringify({
      agents: { Athena: identity("upper"), athena: identity("lower") },
      judges: {},
    });
    const r = refusal(() => parseCredentialFile(text, "/etc/rm/credential.json"));
    expect(r.reason).toBe("duplicate-name");
    expect(r.message).toContain("athena");
  });

  test("the refusal carries the path it was given, so an operator knows which file to fix", () => {
    expect(refusal(() => parseCredentialFile("{", "/etc/rm/credential.json")).path).toBe("/etc/rm/credential.json");
  });
});

// ── LOADING FROM DISK: missing is not empty ────────────────────────────────
describe("loadCredentialFile — a missing file is NEVER an empty roster", () => {
  test("a real file on disk loads and validates", () => {
    const dir = tempDir();
    const path = join(dir, "credential.json");
    writeFileSync(path, JSON.stringify(PROD_ROSTER));
    try {
      expect(loadCredentialFile(path)).toEqual(PROD_ROSTER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a configured path that does not exist refuses with `missing` and names the path", () => {
    const dir = tempDir();
    const path = join(dir, "gone.json");
    try {
      const r = refusal(() => loadCredentialFile(path));
      expect(r.reason).toBe("missing");
      expect(r.path).toBe(path);
      expect(r.message).toContain(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`missing` is not `malformed` — the operator action differs and the gate asserts the reason", () => {
    const dir = tempDir();
    try {
      expect(refusal(() => loadCredentialFile(join(dir, "gone.json"))).reason).toBe("missing");
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "{ not json");
      expect(refusal(() => loadCredentialFile(bad)).reason).toBe("malformed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a path that exists but cannot be read is `unreadable`, never `missing`", () => {
    // A directory where a file was configured: it exists, so it is not
    // missing, and reading it is an I/O error.
    const dir = tempDir();
    const path = join(dir, "credential.json");
    mkdirSync(path);
    try {
      const r = refusal(() => loadCredentialFile(path));
      expect(r.reason).toBe("unreadable");
      expect(r.path).toBe(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an on-disk EMPTY roster loads as an empty roster — the explicit removal instruction", () => {
    const dir = tempDir();
    const path = join(dir, "credential.json");
    writeFileSync(path, '{"agents":{},"judges":{}}');
    try {
      expect(rosterEntries(loadCredentialFile(path))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GATE: a disappeared file refuses BEFORE anything is stopped — participants untouched", () => {
    // Models the caller's order (spec §10 W3): load, reconcile, then stop.
    // The load refusal must happen first, so `stopped` stays empty.
    const stopped: string[] = [];
    const bootParticipants = (path: string, live: readonly RunningParticipant[]) => {
      const file = loadCredentialFile(path);
      const plan = reconcileRoster(rosterEntries(file), live);
      for (const p of plan.stop) stopped.push(p.containerName);
      return plan;
    };
    const live = [running({ name: "athena" }), running({ name: "themis", kind: "judge" })];
    const dir = tempDir();
    try {
      const r = refusal(() => bootParticipants(join(dir, "gone.json"), live));
      expect(r.reason).toBe("missing");
      expect(stopped).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GATE: an EXPLICIT empty roster is the one thing that does stop everyone", () => {
    const dir = tempDir();
    const path = join(dir, "credential.json");
    writeFileSync(path, '{"agents":{},"judges":{}}');
    try {
      const plan = reconcileRoster(rosterEntries(loadCredentialFile(path)), [
        running({ name: "athena" }),
        running({ name: "themis", kind: "judge" }),
      ]);
      expect(plan.stop.map((p) => p.name).sort()).toEqual(["athena", "themis"]);
      expect(plan.start).toEqual([]);
      expect(plan.keep).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── NO PATH CONFIGURED: proceed only when nothing runs ─────────────────────
describe("no credential path configured — proceed with none, or refuse naming what runs", () => {
  test("nothing configured and nothing running is an EMPTY PLAN, not a refusal", () => {
    expect(reconcileRoster(null, [])).toEqual({ start: [], keep: [], stop: [] });
  });

  test("nothing configured WITH participants running refuses `unconfigured-with-running`", () => {
    const live = [running({ name: "athena" }), running({ name: "themis", kind: "judge" })];
    const r = refusal(() => reconcileRoster(null, live));
    expect(r.reason).toBe("unconfigured-with-running");
  });

  test("the refusal NAMES what is running — an operator must be told who was left alone", () => {
    const live = [
      running({ name: "athena", containerName: "rm_prod_participant_athena" }),
      running({ name: "themis", kind: "judge", containerName: "rm_prod_participant_themis" }),
    ];
    const r = refusal(() => reconcileRoster(null, live));
    expect(r.message).toContain("athena");
    expect(r.message).toContain("themis");
    expect(r.running.map((p) => p.name).sort()).toEqual(["athena", "themis"]);
  });

  test("absent configuration is never read as 'stop everyone' — no plan is produced at all", () => {
    const live = [running({ name: "athena" })];
    const r = refusal(() => reconcileRoster(null, live));
    expect(r.reason).not.toBe("missing");
    expect(r.running).toHaveLength(1);
  });
});

// ── FLATTENING: judges are roster entries exactly like agents ──────────────
describe("rosterEntries — one list, judges included, in a stable order", () => {
  test("every entry across both namespaces appears, carrying its own key", () => {
    const entries = rosterEntries(PROD_ROSTER);
    expect(entries).toHaveLength(4);
    const themis = entries.find((e) => e.name === "themis");
    expect(themis?.kind).toBe("judge");
    expect(themis?.identity).toEqual(identity("themis"));
  });

  test("GATE 'judge runs as a participant': the judge is on the list like any agent", () => {
    expect(rosterEntries(PROD_ROSTER).filter((e) => e.kind === "judge").map((e) => e.name)).toEqual(["themis"]);
  });

  test("the order is kind then name, so JSON key order cannot change the plan id", () => {
    const shuffled: CredentialFile = {
      judges: { themis: identity("themis") },
      agents: {
        "robot-money": identity("robot-money"),
        athena: identity("athena"),
        "noop-analyst": identity("noop-analyst"),
      },
    };
    expect(rosterEntries(shuffled).map((e) => `${e.kind}:${e.name}`)).toEqual([
      "agent:athena",
      "agent:noop-analyst",
      "agent:robot-money",
      "judge:themis",
    ]);
    // The same content in another key order flattens identically — this is
    // what keeps the plan id (spec §1.2) stable across file rewrites.
    expect(rosterEntries(shuffled)).toEqual(rosterEntries(PROD_ROSTER));
  });

  test("an agent and a judge sharing a name flatten to TWO entries", () => {
    const file: CredentialFile = {
      agents: { themis: identity("themis-agent") },
      judges: { themis: identity("themis-judge") },
    };
    expect(rosterEntries(file).map((e) => `${e.kind}:${e.name}`)).toEqual(["agent:themis", "judge:themis"]);
  });

  test("an empty roster flattens to an empty list, which is a legitimate desired state", () => {
    expect(rosterEntries({ agents: {}, judges: {} })).toEqual([]);
  });
});

// ── THE PLAN PRINTOUT: no key material, ever ───────────────────────────────
describe("rosterPlanLines — redacted; a plan is pasted into issues and chat logs", () => {
  // Built inside each test: a describe body runs at collection time, and a
  // throw there is an unhandled error rather than a failing test.
  const entries = (): RosterEntry[] => rosterEntries(PROD_ROSTER);

  test("one line per entry, naming the participant and its kind", () => {
    const lines = rosterPlanLines(entries());
    expect(lines).toHaveLength(4);
    expect(lines.join("\n")).toContain("athena");
    expect(lines.join("\n")).toContain("themis");
    expect(lines.some((l) => l.includes("judge") && l.includes("themis"))).toBe(true);
    expect(lines.some((l) => l.includes("agent") && l.includes("athena"))).toBe(true);
  });

  test("NO private key material appears", () => {
    const text = rosterPlanLines(entries()).join("\n");
    expect(text).not.toContain("priv-athena");
    expect(text).not.toContain("privateJwk");
    expect(text).not.toContain("Ed25519");
  });

  test("NOT even the public key — it is still an identity an onlooker can correlate", () => {
    const text = rosterPlanLines(entries()).join("\n");
    expect(text).not.toContain("pub-athena");
    expect(text).not.toContain("pub-themis");
    expect(text).not.toContain("publicKeyB64");
  });

  test("an empty roster prints no lines", () => {
    expect(rosterPlanLines([])).toEqual([]);
  });
});
