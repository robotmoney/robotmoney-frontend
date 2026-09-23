// `--spoof-keys` — the four guards, the path-collision refusal, the four-step
// order and the retry that reuses the persisted generation
// (scripts/lib/swarm/spoof-keys.ts, smoke-production-spec.md §6.4, issue #1026
// W3.5).
//
// WHAT THESE PIN, AND WHY EACH ONE IS A REAL RISK:
//
//   - THE FOUR GUARDS REFUSE INDEPENDENTLY. `RM_ENV = prod`,
//     `deployment_identity ≠ rehearsal`, no `rm_owner` credential, and a flag
//     that was not passed explicitly. Passing one never excuses another: a
//     mistyped `RM_ENV` on a production connection must still refuse on the
//     enrolled identity, because the env var is the operator's claim and the
//     table row is the target's own answer.
//   - THE OUTPUT PATH IS NEVER `RM_CREDENTIALS`. Overwriting it on a
//     mistargeted run destroys the only copy of a host's real participant
//     keys. Equal paths refuse; they never overwrite.
//   - THE ORDER IS (1) write generation → (2) fenced rebind by MEMBER ID →
//     (3) stop old-generation participants → (4) start them. The generation is
//     written BEFORE the rebind: a generation written after a crashed rebind
//     would leave the database holding keys no file records, and those members
//     would be permanently unusable.
//   - A RETRY REUSES THE PERSISTED GENERATION. It does not mint a second one
//     while the database may already hold the first. That is the §10 W3 gate
//     "interrupted rebind then rerun; crash after rebind commit before
//     container replacement recovers."
//
// Cost class `unit` (docs/architecture.md §3 L1): a temp state directory and
// injected database/container dependencies — no Postgres, no Docker, no clock.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertSpoofKeysAllowed,
  readSpoofGeneration,
  rebindSpoofedKeys,
  replaceSpoofedParticipants,
  spoofGenerationPath,
  spoofKeys,
  SpoofKeysRefusal,
  writeSpoofGeneration,
  type SpoofContainerDeps,
  type SpoofGeneration,
  type SpoofGuardContext,
  type SpoofRebindDeps,
} from "../../lib/swarm/spoof-keys.ts";
import type { RunningParticipant } from "../../lib/swarm/credential-file.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rm-spoof-keys-"));
}

/** A context in which every guard passes — each test spoils exactly one field. */
const allowed = (over: Partial<SpoofGuardContext> = {}): SpoofGuardContext => ({
  rmEnv: "stage",
  deploymentIdentity: "rehearsal",
  hasOwnerCredential: true,
  flagExplicit: true,
  outputPath: "/var/lib/rm/rm_twin/spoof-generation.json",
  credentialPath: "/etc/rm/credential.json",
  ...over,
});

function spoofRefusal(fn: () => unknown): SpoofKeysRefusal {
  try {
    fn();
  } catch (err) {
    if (err instanceof SpoofKeysRefusal) return err;
    throw err;
  }
  throw new Error("expected a SpoofKeysRefusal; the call returned normally");
}

async function asyncSpoofRefusal(fn: () => Promise<unknown>): Promise<SpoofKeysRefusal> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof SpoofKeysRefusal) return err;
    throw err;
  }
  throw new Error("expected a SpoofKeysRefusal; the call resolved normally");
}

const running = (name: string, generation?: string): RunningParticipant => ({
  name,
  kind: "agent",
  containerName: `rm_twin_participant_agent_${name}`,
  ...(generation === undefined ? {} : { generation }),
});

const IN_HOUSE = [
  { name: "athena", memberId: "m-athena", operator: "robotmoney" },
  { name: "robot-money", memberId: "m-robot-money", operator: "robotmoney" },
];
const THIRD_PARTY = { name: "outsider", memberId: "m-outsider", operator: "acme" };

/** Records every database call, and refuses a rebind outside the fence. */
function fakeDb(initialInstalled: string | null = null) {
  const calls: string[] = [];
  const rebinds: { memberId: string; publicKeyB64: string; generationId: string }[] = [];
  let installed = initialInstalled;
  let inFence = false;
  let onFenceOpen: (() => void) | undefined;
  const deps: SpoofRebindDeps = {
    async withFencedTransaction<T>(fn: () => Promise<T>): Promise<T> {
      calls.push("fence:open");
      onFenceOpen?.();
      inFence = true;
      try {
        return await fn();
      } finally {
        inFence = false;
        calls.push("fence:close");
      }
    },
    async rebindMemberKey(memberId: string, publicKeyB64: string, generationId: string): Promise<void> {
      if (!inFence) throw new Error(`rebindMemberKey(${memberId}) ran OUTSIDE the fenced transaction`);
      calls.push(`rebind:${memberId}`);
      rebinds.push({ memberId, publicKeyB64, generationId });
      installed = generationId;
    },
    async readInstalledGeneration(): Promise<string | null> {
      calls.push("readInstalled");
      return installed;
    },
  };
  return {
    deps,
    calls,
    rebinds,
    installedGeneration: () => installed,
    onFenceOpen: (fn: () => void) => {
      onFenceOpen = fn;
    },
  };
}

function fakeContainers() {
  const calls: string[] = [];
  const deps: SpoofContainerDeps = {
    async stopParticipant(participant): Promise<void> {
      calls.push(`stop:${participant.name}`);
    },
    async startParticipant(member, generationId): Promise<void> {
      calls.push(`start:${member.name}@${generationId}`);
    },
  };
  return { deps, calls };
}

// ── THE FOUR GUARDS, EACH REFUSING ON ITS OWN ──────────────────────────────
describe("assertSpoofKeysAllowed — four guards, each independently fatal", () => {
  test("a rehearsal twin with an owner credential and an explicit flag is allowed", () => {
    expect(assertSpoofKeysAllowed(allowed())).toBeUndefined();
  });

  test("RM_ENV = prod refuses — spoofing production keys is never a rehearsal flag's business", () => {
    expect(spoofRefusal(() => assertSpoofKeysAllowed(allowed({ rmEnv: "prod" }))).reason).toBe("rm_env_prod");
  });

  test("deployment_identity = production refuses even when RM_ENV says stage", () => {
    // The env var is the operator's CLAIM; the row is the target's own
    // enrollment. A mistyped RM_ENV must not reach a production database.
    const r = spoofRefusal(() =>
      assertSpoofKeysAllowed(allowed({ rmEnv: "stage", deploymentIdentity: "production" })),
    );
    expect(r.reason).toBe("identity_not_rehearsal");
  });

  test("an UNENROLLED target (no deployment_identity row) refuses too — unknown is not rehearsal", () => {
    expect(
      spoofRefusal(() => assertSpoofKeysAllowed(allowed({ deploymentIdentity: null }))).reason,
    ).toBe("identity_not_rehearsal");
  });

  test("no rm_owner credential refuses UP FRONT, not halfway through the rebind", () => {
    expect(
      spoofRefusal(() => assertSpoofKeysAllowed(allowed({ hasOwnerCredential: false }))).reason,
    ).toBe("no_owner_credential");
  });

  test("a flag that was not passed explicitly refuses — never implied, defaulted, or inherited", () => {
    expect(
      spoofRefusal(() => assertSpoofKeysAllowed(allowed({ flagExplicit: false }))).reason,
    ).toBe("flag_not_explicit");
  });

  test("passing one guard never excuses another: an explicit flag on prod still refuses", () => {
    expect(
      spoofRefusal(() => assertSpoofKeysAllowed(allowed({ flagExplicit: true, rmEnv: "prod" }))).reason,
    ).toBe("rm_env_prod");
  });

  test("a rehearsal identity does not excuse a missing owner credential", () => {
    expect(
      spoofRefusal(() =>
        assertSpoofKeysAllowed(allowed({ deploymentIdentity: "rehearsal", hasOwnerCredential: false })),
      ).reason,
    ).toBe("no_owner_credential");
  });

  test("the order is RM_ENV, then identity, then owner credential, then the flag", () => {
    const allBad = allowed({
      rmEnv: "prod",
      deploymentIdentity: "production",
      hasOwnerCredential: false,
      flagExplicit: false,
    });
    expect(spoofRefusal(() => assertSpoofKeysAllowed(allBad)).reason).toBe("rm_env_prod");
    expect(spoofRefusal(() => assertSpoofKeysAllowed({ ...allBad, rmEnv: "stage" })).reason).toBe(
      "identity_not_rehearsal",
    );
    expect(
      spoofRefusal(() =>
        assertSpoofKeysAllowed({ ...allBad, rmEnv: "stage", deploymentIdentity: "rehearsal" }),
      ).reason,
    ).toBe("no_owner_credential");
    expect(
      spoofRefusal(() =>
        assertSpoofKeysAllowed({
          ...allBad,
          rmEnv: "stage",
          deploymentIdentity: "rehearsal",
          hasOwnerCredential: true,
        }),
      ).reason,
    ).toBe("flag_not_explicit");
  });
});

// ── NEVER WRITE THE CREDENTIAL PATH ────────────────────────────────────────
describe("assertSpoofKeysAllowed — the generation is never written over RM_CREDENTIALS", () => {
  test("an output path equal to the credential path refuses instead of overwriting", () => {
    const path = "/etc/rm/credential.json";
    const r = spoofRefusal(() =>
      assertSpoofKeysAllowed(allowed({ outputPath: path, credentialPath: path })),
    );
    expect(r.reason).toBe("credential_path_collision");
    expect(r.message).toContain(path);
  });

  test("a DIFFERENT credential path is fine — the collision is about equality, not about existing", () => {
    expect(
      assertSpoofKeysAllowed(
        allowed({ outputPath: "/var/lib/rm/rm_twin/spoof-generation.json", credentialPath: "/etc/rm/credential.json" }),
      ),
    ).toBeUndefined();
  });

  test("no credential path configured at all cannot collide", () => {
    expect(assertSpoofKeysAllowed(allowed({ credentialPath: null }))).toBeUndefined();
  });

  test("GATE '--spoof-keys with RM_CREDENTIALS set writes elsewhere': the instance path is not the credential path", () => {
    const stateDir = "/var/lib/rm/rm_twin";
    const out = spoofGenerationPath(stateDir, "rm_twin");
    expect(out.startsWith(stateDir)).toBe(true);
    expect(out).not.toBe("/etc/rm/credential.json");
    expect(assertSpoofKeysAllowed(allowed({ outputPath: out, credentialPath: "/etc/rm/credential.json" }))).toBeUndefined();
  });
});

// ── THE INSTANCE-SCOPED PATH ───────────────────────────────────────────────
describe("spoofGenerationPath — instance-scoped, so two rehearsals cannot read each other's generation", () => {
  test("it lands inside the instance's state directory", () => {
    const p = spoofGenerationPath("/var/lib/rm/rm_twin", "rm_twin");
    expect(p.startsWith("/var/lib/rm/rm_twin/")).toBe(true);
    expect(p.endsWith(".json")).toBe(true);
  });

  test("two instances get two different paths", () => {
    expect(spoofGenerationPath("/var/lib/rm/a", "twin-a")).not.toBe(spoofGenerationPath("/var/lib/rm/b", "twin-b"));
  });

  test("it is stable — the same instance resolves to the same path, so a rerun finds its own file", () => {
    expect(spoofGenerationPath("/var/lib/rm/rm_twin", "rm_twin")).toBe(
      spoofGenerationPath("/var/lib/rm/rm_twin", "rm_twin"),
    );
  });
});

// ── STEP (1): WRITE THE GENERATION ─────────────────────────────────────────
describe("writeSpoofGeneration — fresh keypairs, persisted before anything else happens", () => {
  test("it persists a generation carrying one entry per member, keyed by name", () => {
    const dir = tempDir();
    const out = join(dir, "spoof-generation.json");
    try {
      const gen = writeSpoofGeneration(
        [
          { name: "athena", memberId: "m-athena" },
          { name: "robot-money", memberId: "m-robot-money" },
        ],
        out,
        "rm_twin",
      );
      expect(Object.keys(gen.members).sort()).toEqual(["athena", "robot-money"]);
      expect(gen.members.athena?.memberId).toBe("m-athena");
      expect(gen.instance).toBe("rm_twin");
      expect(gen.generationId.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(gen.createdAt))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the file is on disk when the call returns — the rebind must never precede it", () => {
    const dir = tempDir();
    const out = join(dir, "spoof-generation.json");
    try {
      const gen = writeSpoofGeneration([{ name: "athena", memberId: "m-athena" }], out, "rm_twin");
      expect(existsSync(out)).toBe(true);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(JSON.parse(JSON.stringify(gen)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("each member gets its OWN keypair — two members never share a key", () => {
    const dir = tempDir();
    const out = join(dir, "spoof-generation.json");
    try {
      const gen = writeSpoofGeneration(
        [
          { name: "athena", memberId: "m-athena" },
          { name: "robot-money", memberId: "m-robot-money" },
        ],
        out,
        "rm_twin",
      );
      const a = gen.members.athena?.identity;
      const b = gen.members["robot-money"]?.identity;
      expect(a?.publicKeyB64).toBeTruthy();
      expect(b?.publicKeyB64).toBeTruthy();
      expect(a?.publicKeyB64).not.toBe(b?.publicKeyB64);
      expect(a?.privateJwk).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two separate generations are distinct — a fresh call mints fresh keys", () => {
    const dir = tempDir();
    try {
      const first = writeSpoofGeneration([{ name: "athena", memberId: "m-athena" }], join(dir, "a.json"), "rm_twin");
      const second = writeSpoofGeneration([{ name: "athena", memberId: "m-athena" }], join(dir, "b.json"), "rm_twin");
      expect(first.generationId).not.toBe(second.generationId);
      expect(first.members.athena?.identity.publicKeyB64).not.toBe(second.members.athena?.identity.publicKeyB64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the write leaves no temp file behind — it is a write-then-rename", () => {
    const dir = tempDir();
    try {
      writeSpoofGeneration([{ name: "athena", memberId: "m-athena" }], join(dir, "spoof-generation.json"), "rm_twin");
      expect(readdirSync(dir)).toEqual(["spoof-generation.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── READING IT BACK: absent is null, corrupt is a refusal ──────────────────
describe("readSpoofGeneration — a corrupt generation is NOT an absent one", () => {
  test("no file at all is `null` — a first run", () => {
    const dir = tempDir();
    try {
      expect(readSpoofGeneration(join(dir, "spoof-generation.json"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a persisted generation round-trips with its member ids and keys", () => {
    const dir = tempDir();
    const out = join(dir, "spoof-generation.json");
    try {
      const written = writeSpoofGeneration([{ name: "athena", memberId: "m-athena" }], out, "rm_twin");
      const read = readSpoofGeneration(out);
      expect(read?.generationId).toBe(written.generationId);
      expect(read?.members.athena?.memberId).toBe("m-athena");
      expect(read?.members.athena?.identity.publicKeyB64).toBe(written.members.athena?.identity.publicKeyB64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a MALFORMED file refuses rather than reporting `null` and minting a second generation", () => {
    const dir = tempDir();
    const out = join(dir, "spoof-generation.json");
    writeFileSync(out, "{ half a file");
    try {
      // Reporting a corrupt generation as absent would mint a SECOND
      // generation while the database may already hold the first, stranding
      // the members the write-first ordering exists to protect.
      expect(() => readSpoofGeneration(out)).toThrow(/spoof-generation\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a well-formed JSON file that is not a generation also refuses", () => {
    const dir = tempDir();
    const out = join(dir, "spoof-generation.json");
    writeFileSync(out, JSON.stringify({ hello: "world" }));
    try {
      expect(() => readSpoofGeneration(out)).toThrow(/generationId/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── STEP (2): ONE FENCED TRANSACTION, KEYED BY MEMBER ID ───────────────────
describe("rebindSpoofedKeys — one fenced transaction, keyed by member id, idempotent on rerun", () => {
  const generation: SpoofGeneration = {
    generationId: "gen-abc",
    createdAt: "2026-09-23T00:00:00.000Z",
    instance: "rm_twin",
    members: {
      athena: { name: "athena", memberId: "m-athena", identity: { publicKeyB64: "pub-a", privateJwk: { kty: "OKP" } } },
      "robot-money": {
        name: "robot-money",
        memberId: "m-robot-money",
        identity: { publicKeyB64: "pub-r", privateJwk: { kty: "OKP" } },
      },
    },
  };

  test("every named member is rebound BY MEMBER ID, never by display name", async () => {
    const db = fakeDb(null);
    await rebindSpoofedKeys(generation, db.deps);
    expect(db.rebinds.map((r) => r.memberId).sort()).toEqual(["m-athena", "m-robot-money"]);
    expect(db.rebinds.map((r) => r.publicKeyB64).sort()).toEqual(["pub-a", "pub-r"]);
  });

  test("every rebind carries the generation id, so containers can be matched against it", async () => {
    const db = fakeDb(null);
    await rebindSpoofedKeys(generation, db.deps);
    expect(db.rebinds.every((r) => r.generationId === "gen-abc")).toBe(true);
  });

  test("all rebinds happen inside ONE fence — a partial rebind is not a state this design has", async () => {
    const db = fakeDb(null);
    await rebindSpoofedKeys(generation, db.deps);
    expect(db.calls.filter((c) => c === "fence:open")).toHaveLength(1);
    const open = db.calls.indexOf("fence:open");
    const close = db.calls.indexOf("fence:close");
    for (const [i, call] of db.calls.entries()) {
      if (call.startsWith("rebind:")) {
        expect(i).toBeGreaterThan(open);
        expect(i).toBeLessThan(close);
      }
    }
  });

  test("RERUN: a database already at this generation is NOT rebound again", async () => {
    const db = fakeDb("gen-abc");
    await rebindSpoofedKeys(generation, db.deps);
    expect(db.rebinds).toEqual([]);
    expect(db.calls.filter((c) => c.startsWith("rebind:"))).toEqual([]);
  });

  test("a database at an OLDER generation IS rebound", async () => {
    const db = fakeDb("gen-older");
    await rebindSpoofedKeys(generation, db.deps);
    expect(db.rebinds.map((r) => r.memberId).sort()).toEqual(["m-athena", "m-robot-money"]);
  });
});

// ── STEPS (3) AND (4): STOP THE OLD, THEN START THE NEW ────────────────────
describe("replaceSpoofedParticipants — stop-then-start, never a rolling restart", () => {
  const generation: SpoofGeneration = {
    generationId: "gen-2",
    createdAt: "2026-09-23T00:00:00.000Z",
    instance: "rm_twin",
    members: {
      athena: { name: "athena", memberId: "m-athena", identity: { publicKeyB64: "pub-a", privateJwk: { kty: "OKP" } } },
    },
  };

  test("an older-generation container is stopped and the new one started", async () => {
    const containers = fakeContainers();
    await replaceSpoofedParticipants(generation, [running("athena", "gen-1")], containers.deps);
    expect(containers.calls).toEqual(["stop:athena", "start:athena@gen-2"]);
  });

  test("EVERY stop precedes EVERY start — two containers for one member must never overlap", async () => {
    const containers = fakeContainers();
    const gen: SpoofGeneration = {
      ...generation,
      members: {
        ...generation.members,
        "robot-money": {
          name: "robot-money",
          memberId: "m-robot-money",
          identity: { publicKeyB64: "pub-r", privateJwk: { kty: "OKP" } },
        },
      },
    };
    await replaceSpoofedParticipants(gen, [running("athena", "gen-1"), running("robot-money", "gen-1")], containers.deps);
    const lastStop = containers.calls.map((c) => c.startsWith("stop:")).lastIndexOf(true);
    const firstStart = containers.calls.findIndex((c) => c.startsWith("start:"));
    expect(firstStart).toBeGreaterThan(lastStop);
  });

  test("a container ALREADY on this generation is left alone — a rerun does not restart healthy containers", async () => {
    const containers = fakeContainers();
    await replaceSpoofedParticipants(generation, [running("athena", "gen-2")], containers.deps);
    expect(containers.calls).toEqual([]);
  });

  test("a container with no generation at all is superseded and replaced", async () => {
    const containers = fakeContainers();
    await replaceSpoofedParticipants(generation, [running("athena")], containers.deps);
    expect(containers.calls).toEqual(["stop:athena", "start:athena@gen-2"]);
  });

  test("a spoofed member with no running container is simply started", async () => {
    const containers = fakeContainers();
    await replaceSpoofedParticipants(generation, [], containers.deps);
    expect(containers.calls).toEqual(["start:athena@gen-2"]);
  });
});

// ── THE WHOLE OPERATION, IN ORDER, RESUMABLE ───────────────────────────────
describe("spoofKeys — guards, then (1)(2)(3)(4), resumable by rerun", () => {
  test("a full first run writes the generation, rebinds by id, and replaces the containers", async () => {
    const dir = tempDir();
    const out = spoofGenerationPath(dir, "rm_twin");
    const db = fakeDb(null);
    const containers = fakeContainers();
    try {
      const outcome = await spoofKeys({
        guards: allowed({ outputPath: out }),
        instance: "rm_twin",
        stateDir: dir,
        names: [],
        members: IN_HOUSE,
        running: [running("athena", "gen-old"), running("robot-money", "gen-old")],
        db: db.deps,
        containers: containers.deps,
      });
      expect(outcome.generationPath).toBe(out);
      expect(outcome.resumed).toBe(false);
      expect([...outcome.rebound].sort()).toEqual(["athena", "robot-money"]);
      expect([...outcome.restarted].sort()).toEqual(["athena", "robot-money"]);
      expect(db.installedGeneration()).toBe(outcome.generationId);
      expect(readSpoofGeneration(out)?.generationId).toBe(outcome.generationId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the generation file EXISTS before the rebind transaction opens", async () => {
    // Written after a crashed rebind, the database would hold keys no file
    // records and the members would be permanently unusable.
    const dir = tempDir();
    const out = spoofGenerationPath(dir, "rm_twin");
    const db = fakeDb(null);
    let fileWhenFenceOpened = false;
    db.onFenceOpen(() => {
      fileWhenFenceOpened = existsSync(out);
    });
    try {
      await spoofKeys({
        guards: allowed({ outputPath: out }),
        instance: "rm_twin",
        stateDir: dir,
        names: [],
        members: IN_HOUSE,
        running: [],
        db: db.deps,
        containers: fakeContainers().deps,
      });
      expect(fileWhenFenceOpened).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GATE 'crash after rebind commit before container replacement recovers': the RERUN reuses the persisted generation", async () => {
    const dir = tempDir();
    const out = spoofGenerationPath(dir, "rm_twin");
    try {
      // First run: reaches the commit, then the process dies before (3)/(4).
      const first = await spoofKeys({
        guards: allowed({ outputPath: out }),
        instance: "rm_twin",
        stateDir: dir,
        names: [],
        members: IN_HOUSE,
        running: [],
        db: fakeDb(null).deps,
        containers: fakeContainers().deps,
      });
      const persistedKey = readSpoofGeneration(out)?.members.athena?.identity.publicKeyB64;

      // The rerun: the database already reports the persisted generation.
      const db2 = fakeDb(first.generationId);
      const containers2 = fakeContainers();
      const second = await spoofKeys({
        guards: allowed({ outputPath: out }),
        instance: "rm_twin",
        stateDir: dir,
        names: [],
        members: IN_HOUSE,
        running: [running("athena", "gen-old")],
        db: db2.deps,
        containers: containers2.deps,
      });

      expect(second.generationId).toBe(first.generationId);
      expect(second.resumed).toBe(true);
      expect(second.rebound).toEqual([]);
      expect(db2.rebinds).toEqual([]);
      // No second generation was minted: the file still holds the first keys.
      expect(readSpoofGeneration(out)?.generationId).toBe(first.generationId);
      expect(readSpoofGeneration(out)?.members.athena?.identity.publicKeyB64).toBe(persistedKey);
      // And the stale container was still replaced — steps (3) and (4) ran.
      expect(containers2.calls).toContain("stop:athena");
      expect(containers2.calls).toContain(`start:athena@${first.generationId}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GATE 'interrupted rebind then rerun': a rerun before the commit rebinds under the SAME generation", async () => {
    const dir = tempDir();
    const out = spoofGenerationPath(dir, "rm_twin");
    try {
      const first = writeSpoofGeneration(
        IN_HOUSE.map((m) => ({ name: m.name, memberId: m.memberId })),
        out,
        "rm_twin",
      );
      const db = fakeDb(null); // the interrupted run never committed
      const outcome = await spoofKeys({
        guards: allowed({ outputPath: out }),
        instance: "rm_twin",
        stateDir: dir,
        names: [],
        members: IN_HOUSE,
        running: [],
        db: db.deps,
        containers: fakeContainers().deps,
      });
      expect(outcome.generationId).toBe(first.generationId);
      expect(db.rebinds.map((r) => r.memberId).sort()).toEqual(["m-athena", "m-robot-money"]);
      expect(db.rebinds.every((r) => r.generationId === first.generationId)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with no names given, the default membership is every `operator = robotmoney` member", async () => {
    const dir = tempDir();
    const out = spoofGenerationPath(dir, "rm_twin");
    try {
      const outcome = await spoofKeys({
        guards: allowed({ outputPath: out }),
        instance: "rm_twin",
        stateDir: dir,
        names: [],
        members: [...IN_HOUSE, THIRD_PARTY],
        running: [],
        db: fakeDb(null).deps,
        containers: fakeContainers().deps,
      });
      expect([...outcome.rebound].sort()).toEqual(["athena", "robot-money"]);
      expect(outcome.rebound).not.toContain("outsider");
      expect(Object.keys(readSpoofGeneration(out)?.members ?? {})).not.toContain("outsider");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an EXPLICIT name list still never reaches a third party's member — their key is theirs", async () => {
    const dir = tempDir();
    const out = spoofGenerationPath(dir, "rm_twin");
    try {
      await expect(
        spoofKeys({
          guards: allowed({ outputPath: out }),
          instance: "rm_twin",
          stateDir: dir,
          names: ["outsider"],
          members: [...IN_HOUSE, THIRD_PARTY],
          running: [],
          db: fakeDb(null).deps,
          containers: fakeContainers().deps,
        }),
      ).rejects.toThrow(/outsider/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicit name list spoofs exactly those in-house members", async () => {
    const dir = tempDir();
    const out = spoofGenerationPath(dir, "rm_twin");
    try {
      const outcome = await spoofKeys({
        guards: allowed({ outputPath: out }),
        instance: "rm_twin",
        stateDir: dir,
        names: ["athena"],
        members: IN_HOUSE,
        running: [],
        db: fakeDb(null).deps,
        containers: fakeContainers().deps,
      });
      expect(outcome.rebound).toEqual(["athena"]);
      expect(Object.keys(readSpoofGeneration(out)?.members ?? {})).toEqual(["athena"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a refused run generates NOTHING — no file, no rebind, no container touched", async () => {
    const dir = tempDir();
    const out = spoofGenerationPath(dir, "rm_twin");
    const db = fakeDb(null);
    const containers = fakeContainers();
    try {
      const r = await asyncSpoofRefusal(() =>
        spoofKeys({
          guards: allowed({ outputPath: out, rmEnv: "prod" }),
          instance: "rm_twin",
          stateDir: dir,
          names: [],
          members: IN_HOUSE,
          running: [running("athena", "gen-old")],
          db: db.deps,
          containers: containers.deps,
        }),
      );
      expect(r.reason).toBe("rm_env_prod");
      expect(existsSync(out)).toBe(false);
      expect(db.rebinds).toEqual([]);
      expect(containers.calls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a credential-path collision refuses without writing anywhere", async () => {
    const dir = tempDir();
    const out = spoofGenerationPath(dir, "rm_twin");
    try {
      const r = await asyncSpoofRefusal(() =>
        spoofKeys({
          guards: allowed({ outputPath: out, credentialPath: out }),
          instance: "rm_twin",
          stateDir: dir,
          names: [],
          members: IN_HOUSE,
          running: [],
          db: fakeDb(null).deps,
          containers: fakeContainers().deps,
        }),
      );
      expect(r.reason).toBe("credential_path_collision");
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
