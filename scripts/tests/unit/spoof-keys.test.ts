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
//     keys. Paths naming the same file refuse — including a `..`, relative or
//     symlinked spelling, which a string comparison would wave through.
//   - THE PATH IS THE INSTANCE STATE DIRECTORY'S, COMPUTED BY THE MODULE.
//     `spoofKeys` takes the state root and instance and writes
//     `instancePaths(stateRoot, instance).spoofGenerationFile`; no caller can
//     point the generation anywhere else.
//   - EACH MEMBER GETS A KEYPAIR AND A BEARER, both issued inside the fence,
//     and while a generation exists a plain boot's roster takes those
//     members' key and bearer from it rather than from `RM_CREDENTIALS`.
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
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { instancePaths } from "../../lib/smoke-state.ts";
import {
  assertSpoofKeysAllowed,
  effectiveRoster,
  readSpoofGeneration,
  rebindSpoofedKeys,
  replaceSpoofedParticipants,
  spoofKeys,
  SpoofKeysRefusal,
  writeSpoofGeneration,
  type SpoofContainerDeps,
  type SpoofGeneration,
  type SpoofGuardContext,
  type SpoofRebindDeps,
} from "../../lib/swarm/spoof-keys.ts";
import type { RosterEntry, RunningParticipant } from "../../lib/swarm/credential-file.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "rm-spoof-keys-"));
}

/** A context in which every guard passes — each test spoils exactly one field. */
const allowed = (over: Partial<SpoofGuardContext> = {}): SpoofGuardContext => ({
  rmEnv: "stage",
  deploymentIdentity: "rehearsal",
  hasOwnerCredential: true,
  flagExplicit: true,
  credentialPath: "/etc/rm/credential.json",
  ...over,
});

/** Where `spoofKeys` would write for instance `rm_twin` under `/var/lib/rm`. */
const GEN = instancePaths("/var/lib/rm", "rm_twin").spoofGenerationFile;

/** The generation file `spoofKeys` owns for `instance` under `root`. */
const genFile = (root: string, instance = "rm_twin") => instancePaths(root, instance).spoofGenerationFile;

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
  const tokens: { memberId: string; bearer: string; generationId: string }[] = [];
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
    async issueMemberToken(memberId: string, bearer: string, generationId: string): Promise<void> {
      if (!inFence) throw new Error(`issueMemberToken(${memberId}) ran OUTSIDE the fenced transaction`);
      calls.push(`token:${memberId}`);
      tokens.push({ memberId, bearer, generationId });
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
    tokens,
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
    expect(assertSpoofKeysAllowed(allowed(), GEN)).toBeUndefined();
  });

  test("RM_ENV = prod refuses — spoofing production keys is never a rehearsal flag's business", () => {
    expect(spoofRefusal(() => assertSpoofKeysAllowed(allowed({ rmEnv: "prod" }), GEN)).reason).toBe("rm_env_prod");
  });

  test("deployment_identity = production refuses even when RM_ENV says stage", () => {
    // The env var is the operator's CLAIM; the row is the target's own
    // enrollment. A mistyped RM_ENV must not reach a production database.
    const r = spoofRefusal(() =>
      assertSpoofKeysAllowed(allowed({ rmEnv: "stage", deploymentIdentity: "production" }), GEN),
    );
    expect(r.reason).toBe("identity_not_rehearsal");
  });

  test("an UNENROLLED target (no deployment_identity row) refuses too — unknown is not rehearsal", () => {
    expect(
      spoofRefusal(() => assertSpoofKeysAllowed(allowed({ deploymentIdentity: null }), GEN)).reason,
    ).toBe("identity_not_rehearsal");
  });

  test("no rm_owner credential refuses UP FRONT, not halfway through the rebind", () => {
    expect(
      spoofRefusal(() => assertSpoofKeysAllowed(allowed({ hasOwnerCredential: false }), GEN)).reason,
    ).toBe("no_owner_credential");
  });

  test("a flag that was not passed explicitly refuses — never implied, defaulted, or inherited", () => {
    expect(
      spoofRefusal(() => assertSpoofKeysAllowed(allowed({ flagExplicit: false }), GEN)).reason,
    ).toBe("flag_not_explicit");
  });

  test("passing one guard never excuses another: an explicit flag on prod still refuses", () => {
    expect(
      spoofRefusal(() => assertSpoofKeysAllowed(allowed({ flagExplicit: true, rmEnv: "prod" }), GEN)).reason,
    ).toBe("rm_env_prod");
  });

  test("a rehearsal identity does not excuse a missing owner credential", () => {
    expect(
      spoofRefusal(() =>
        assertSpoofKeysAllowed(allowed({ deploymentIdentity: "rehearsal", hasOwnerCredential: false }), GEN),
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
    expect(spoofRefusal(() => assertSpoofKeysAllowed(allBad, GEN)).reason).toBe("rm_env_prod");
    expect(spoofRefusal(() => assertSpoofKeysAllowed({ ...allBad, rmEnv: "stage" }, GEN)).reason).toBe(
      "identity_not_rehearsal",
    );
    expect(
      spoofRefusal(() =>
        assertSpoofKeysAllowed({ ...allBad, rmEnv: "stage", deploymentIdentity: "rehearsal" }, GEN),
      ).reason,
    ).toBe("no_owner_credential");
    expect(
      spoofRefusal(() =>
        assertSpoofKeysAllowed({
          ...allBad,
          rmEnv: "stage",
          deploymentIdentity: "rehearsal",
          hasOwnerCredential: true,
        }, GEN),
      ).reason,
    ).toBe("flag_not_explicit");
  });
});

// ── NEVER WRITE THE CREDENTIAL PATH ────────────────────────────────────────
describe("assertSpoofKeysAllowed — the generation is never written over RM_CREDENTIALS", () => {
  test("an output path equal to the credential path refuses instead of overwriting", () => {
    const path = "/etc/rm/credential.json";
    const r = spoofRefusal(() => assertSpoofKeysAllowed(allowed({ credentialPath: path }), path));
    expect(r.reason).toBe("credential_path_collision");
    expect(r.message).toContain(path);
  });

  test("a DIFFERENT credential path is fine — the collision is about equality, not about existing", () => {
    expect(assertSpoofKeysAllowed(allowed({ credentialPath: "/etc/rm/credential.json" }), GEN)).toBeUndefined();
  });

  test("no credential path configured at all cannot collide", () => {
    expect(assertSpoofKeysAllowed(allowed({ credentialPath: null }), GEN)).toBeUndefined();
  });

  test("a `..` spelling of the generation path refuses — RM_CREDENTIALS is taken verbatim, not normalized", () => {
    // /var/lib/rm/rm_twin/../rm_twin/spoof-generation is the generation file.
    const dotted = GEN.replace("/rm_twin/", "/rm_twin/../rm_twin/");
    expect(dotted).not.toBe(GEN);
    const r = spoofRefusal(() => assertSpoofKeysAllowed(allowed({ credentialPath: dotted }), GEN));
    expect(r.reason).toBe("credential_path_collision");
  });

  test("a RELATIVE spelling of the generation path refuses — it is resolved against the working directory", () => {
    const root = tempDir();
    try {
      const gen = genFile(root);
      const rel = relative(process.cwd(), gen);
      expect(rel.startsWith("/")).toBe(false);
      const r = spoofRefusal(() => assertSpoofKeysAllowed(allowed({ credentialPath: rel }), gen));
      expect(r.reason).toBe("credential_path_collision");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a SYMLINKED directory spelling refuses even before the generation file exists", () => {
    const root = tempDir();
    try {
      const paths = instancePaths(root, "rm_twin", { create: true });
      const alias = join(root, "alias");
      symlinkSync(paths.dir, alias, "dir");
      const viaAlias = join(alias, "spoof-generation");
      expect(existsSync(paths.spoofGenerationFile)).toBe(false);
      const r = spoofRefusal(() =>
        assertSpoofKeysAllowed(allowed({ credentialPath: viaAlias }), paths.spoofGenerationFile),
      );
      expect(r.reason).toBe("credential_path_collision");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a credential file that is a SYMLINK to the generation file refuses", () => {
    const root = tempDir();
    try {
      const paths = instancePaths(root, "rm_twin", { create: true });
      writeFileSync(paths.spoofGenerationFile, "{}");
      const cred = join(root, "credential.json");
      symlinkSync(paths.spoofGenerationFile, cred, "file");
      const r = spoofRefusal(() =>
        assertSpoofKeysAllowed(allowed({ credentialPath: cred }), paths.spoofGenerationFile),
      );
      expect(r.reason).toBe("credential_path_collision");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a HARD LINK to the generation file refuses — one inode is one file whatever its names", () => {
    const root = tempDir();
    try {
      const paths = instancePaths(root, "rm_twin", { create: true });
      writeFileSync(paths.spoofGenerationFile, "{}");
      const cred = join(root, "credential.json");
      linkSync(paths.spoofGenerationFile, cred);
      const r = spoofRefusal(() =>
        assertSpoofKeysAllowed(allowed({ credentialPath: cred }), paths.spoofGenerationFile),
      );
      expect(r.reason).toBe("credential_path_collision");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a sibling file in the same directory is NOT a collision — canonicalizing must not over-refuse", () => {
    const root = tempDir();
    try {
      const paths = instancePaths(root, "rm_twin", { create: true });
      writeFileSync(paths.spoofGenerationFile, "{}");
      const cred = join(paths.dir, "credential.json");
      writeFileSync(cred, "{}");
      expect(assertSpoofKeysAllowed(allowed({ credentialPath: cred }), paths.spoofGenerationFile)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("GATE '--spoof-keys with RM_CREDENTIALS set writes elsewhere': the credential file is untouched", async () => {
    const root = tempDir();
    try {
      const cred = join(root, "credential.json");
      const original = JSON.stringify({ agents: { athena: { real: true } }, judges: {} });
      writeFileSync(cred, original);
      const outcome = await spoofKeys({
        guards: allowed({ credentialPath: cred }),
        instance: "rm_twin",
        stateRoot: root,
        names: [],
        members: IN_HOUSE,
        running: [],
        db: fakeDb(null).deps,
        containers: fakeContainers().deps,
      });
      expect(outcome.generationPath).toBe(genFile(root));
      expect(outcome.generationPath).not.toBe(cred);
      expect(readFileSync(cred, "utf8")).toBe(original);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ── THE INSTANCE-SCOPED PATH, COMPUTED BY THE MODULE ───────────────────────
describe("spoofKeys — the generation lands in instancePaths(stateRoot, instance), which the module computes", () => {
  test("given only a state root and an instance, the file appears at instancePaths(...).spoofGenerationFile", async () => {
    // Fails if `stateRoot` is ignored: nothing else in the options names a
    // directory, so the file could only land here by reading it.
    const root = tempDir();
    try {
      const outcome = await spoofKeys({
        guards: allowed(),
        instance: "rm_twin",
        stateRoot: root,
        names: [],
        members: IN_HOUSE,
        running: [],
        db: fakeDb(null).deps,
        containers: fakeContainers().deps,
      });
      const expected = instancePaths(root, "rm_twin").spoofGenerationFile;
      expect(outcome.generationPath).toBe(expected);
      expect(existsSync(expected)).toBe(true);
      expect(JSON.parse(readFileSync(expected, "utf8")).generationId).toBe(outcome.generationId);
      // Nothing written anywhere else under the root.
      expect(readdirSync(root)).toEqual(["rm_twin"]);
      expect(readdirSync(instancePaths(root, "rm_twin").dir)).toEqual(["spoof-generation"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("two instances under one root get two files — neither reads the other's generation", async () => {
    const root = tempDir();
    try {
      const run = (instance: string) =>
        spoofKeys({
          guards: allowed(),
          instance,
          stateRoot: root,
          names: [],
          members: IN_HOUSE,
          running: [],
          db: fakeDb(null).deps,
          containers: fakeContainers().deps,
        });
      const a = await run("twin-a");
      const b = await run("twin-b");
      expect(a.generationPath).toBe(genFile(root, "twin-a"));
      expect(b.generationPath).toBe(genFile(root, "twin-b"));
      expect(a.generationId).not.toBe(b.generationId);
      expect(readSpoofGeneration(root, "twin-a")?.generationId).toBe(a.generationId);
      expect(readSpoofGeneration(root, "twin-b")?.generationId).toBe(b.generationId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the file name is smoke-state's `spoof-generation` — one name, not a second spelling", () => {
    expect(genFile("/var/lib/rm")).toBe("/var/lib/rm/rm_twin/spoof-generation");
  });
});

// ── STEP (1): WRITE THE GENERATION ─────────────────────────────────────────
describe("writeSpoofGeneration — fresh keypairs and bearers, persisted before anything else happens", () => {
  const TWO = [
    { name: "athena", memberId: "m-athena" },
    { name: "robot-money", memberId: "m-robot-money" },
  ];

  test("it persists a generation carrying one entry per member, keyed by name", () => {
    const dir = tempDir();
    try {
      const gen = writeSpoofGeneration(TWO, dir, "rm_twin");
      expect(Object.keys(gen.members).sort()).toEqual(["athena", "robot-money"]);
      expect(gen.members.athena?.memberId).toBe("m-athena");
      expect(gen.instance).toBe("rm_twin");
      expect(gen.generationId.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(gen.createdAt))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the file is on disk at the instance path when the call returns — the rebind must never precede it", () => {
    const dir = tempDir();
    try {
      const gen = writeSpoofGeneration([{ name: "athena", memberId: "m-athena" }], dir, "rm_twin");
      const out = genFile(dir);
      expect(existsSync(out)).toBe(true);
      expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(JSON.parse(JSON.stringify(gen)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("each member gets its OWN keypair — two members never share a key", () => {
    const dir = tempDir();
    try {
      const gen = writeSpoofGeneration(TWO, dir, "rm_twin");
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

  test("each member gets its OWN bearer, in the server's token shape, persisted with the keys", () => {
    // A shared bearer would let any container holding it act as every
    // spoofed member; a missing one leaves the twin's members unable to call
    // the API at all, since their real bearers are not on this host.
    const dir = tempDir();
    try {
      const gen = writeSpoofGeneration(TWO, dir, "rm_twin");
      const a = gen.members.athena?.bearer;
      const b = gen.members["robot-money"]?.bearer;
      expect(a).toMatch(/^tok_m-athena_[0-9a-f-]{36}$/);
      expect(b).toMatch(/^tok_m-robot-money_[0-9a-f-]{36}$/);
      expect(a).not.toBe(b);
      const onDisk = JSON.parse(readFileSync(genFile(dir), "utf8")) as SpoofGeneration;
      expect(onDisk.members.athena?.bearer).toBe(a as string);
      expect(onDisk.members["robot-money"]?.bearer).toBe(b as string);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("two separate generations are distinct — a fresh call mints fresh keys and bearers", () => {
    const a = tempDir();
    const b = tempDir();
    try {
      const first = writeSpoofGeneration([{ name: "athena", memberId: "m-athena" }], a, "rm_twin");
      const second = writeSpoofGeneration([{ name: "athena", memberId: "m-athena" }], b, "rm_twin");
      expect(first.generationId).not.toBe(second.generationId);
      expect(first.members.athena?.identity.publicKeyB64).not.toBe(second.members.athena?.identity.publicKeyB64);
      expect(first.members.athena?.bearer).not.toBe(second.members.athena?.bearer);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  test("the write leaves no temp file behind — it is a write-then-rename", () => {
    const dir = tempDir();
    try {
      writeSpoofGeneration([{ name: "athena", memberId: "m-athena" }], dir, "rm_twin");
      expect(readdirSync(instancePaths(dir, "rm_twin").dir)).toEqual(["spoof-generation"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── READING IT BACK: absent is null, corrupt is a refusal ──────────────────
describe("readSpoofGeneration — a corrupt generation is NOT an absent one", () => {
  /** Put raw text where the instance's generation file lives. */
  function plant(root: string, text: string): string {
    const out = instancePaths(root, "rm_twin", { create: true }).spoofGenerationFile;
    writeFileSync(out, text);
    return out;
  }

  test("no file at all is `null` — a first run", () => {
    const dir = tempDir();
    try {
      expect(readSpoofGeneration(dir, "rm_twin")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a persisted generation round-trips with its member ids, keys and bearers", () => {
    const dir = tempDir();
    try {
      const written = writeSpoofGeneration([{ name: "athena", memberId: "m-athena" }], dir, "rm_twin");
      const read = readSpoofGeneration(dir, "rm_twin");
      expect(read?.generationId).toBe(written.generationId);
      expect(read?.members.athena?.memberId).toBe("m-athena");
      expect(read?.members.athena?.identity.publicKeyB64).toBe(written.members.athena?.identity.publicKeyB64);
      expect(read?.members.athena?.bearer).toBe(written.members.athena?.bearer as string);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a MALFORMED file refuses rather than reporting `null` and minting a second generation", () => {
    const dir = tempDir();
    plant(dir, "{ half a file");
    try {
      // Reporting a corrupt generation as absent would mint a SECOND
      // generation while the database may already hold the first, stranding
      // the members the write-first ordering exists to protect.
      expect(() => readSpoofGeneration(dir, "rm_twin")).toThrow(/spoof-generation/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a well-formed JSON file that is not a generation also refuses", () => {
    const dir = tempDir();
    plant(dir, JSON.stringify({ hello: "world" }));
    try {
      expect(() => readSpoofGeneration(dir, "rm_twin")).toThrow(/generationId/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a member entry with no bearer refuses — a plain boot would start it unable to authenticate", () => {
    const dir = tempDir();
    plant(
      dir,
      JSON.stringify({
        generationId: "gen-x",
        createdAt: "2026-09-24T00:00:00.000Z",
        instance: "rm_twin",
        members: {
          athena: { name: "athena", memberId: "m-athena", identity: { publicKeyB64: "pub", privateJwk: { kty: "OKP" } } },
        },
      }),
    );
    try {
      expect(() => readSpoofGeneration(dir, "rm_twin")).toThrow(/athena lacks/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a file naming ANOTHER instance refuses — it was copied or misplaced, and holds someone else's keys", () => {
    const dir = tempDir();
    try {
      writeSpoofGeneration([{ name: "athena", memberId: "m-athena" }], dir, "twin-a");
      const foreign = readFileSync(genFile(dir, "twin-a"), "utf8");
      plant(dir, foreign);
      expect(() => readSpoofGeneration(dir, "rm_twin")).toThrow(/twin-a, not rm_twin/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── ROSTER PRECEDENCE: the generation wins for its members, only while it exists
describe("effectiveRoster — while a generation exists, its members boot on its key and bearer", () => {
  const fileEntry = (name: string, kind: "agent" | "judge" = "agent"): RosterEntry => ({
    name,
    kind,
    identity: { publicKeyB64: `file-pub-${name}`, privateJwk: { kty: "OKP", d: `file-${name}` } },
  });
  const FILE = [fileEntry("athena"), fileEntry("noop-analyst"), fileEntry("themis", "judge")];
  const generation: SpoofGeneration = {
    generationId: "gen-p",
    createdAt: "2026-09-24T00:00:00.000Z",
    instance: "rm_twin",
    members: {
      athena: {
        name: "athena",
        memberId: "m-athena",
        identity: { publicKeyB64: "spoof-pub-athena", privateJwk: { kty: "OKP", d: "spoof-athena" } },
        bearer: "tok_m-athena_spoofed",
      },
    },
  };

  test("with a generation, a spoofed member takes the GENERATION's key and bearer, not RM_CREDENTIALS'", () => {
    const roster = effectiveRoster(FILE, generation);
    const athena = roster.find((e) => e.name === "athena");
    expect(athena?.identity.publicKeyB64).toBe("spoof-pub-athena");
    expect(athena?.identity.privateJwk).toEqual({ kty: "OKP", d: "spoof-athena" });
    expect(athena?.bearer).toBe("tok_m-athena_spoofed");
  });

  test("with a generation, a member it does NOT name keeps the file's entry untouched", () => {
    const roster = effectiveRoster(FILE, generation);
    expect(roster.find((e) => e.name === "noop-analyst")).toEqual(fileEntry("noop-analyst"));
    expect(roster.find((e) => e.name === "themis")).toEqual(fileEntry("themis", "judge"));
  });

  test("with NO generation, the file is returned unchanged — RM_CREDENTIALS is the roster", () => {
    expect(effectiveRoster(FILE, null)).toEqual(FILE);
  });

  test("the generation never ADDS a member — the credential file stays the roster, order preserved", () => {
    const withExtra: SpoofGeneration = {
      ...generation,
      members: {
        ...generation.members,
        "robot-money": {
          name: "robot-money",
          memberId: "m-robot-money",
          identity: { publicKeyB64: "spoof-pub-r", privateJwk: { kty: "OKP" } },
          bearer: "tok_m-robot-money_spoofed",
        },
      },
    };
    expect(effectiveRoster(FILE, withExtra).map((e) => e.name)).toEqual(["athena", "noop-analyst", "themis"]);
  });

  test("names match the way reconcileRoster matches them — trimmed and case-folded", () => {
    const roster = effectiveRoster([fileEntry(" Athena ")], generation);
    expect(roster[0]?.identity.publicKeyB64).toBe("spoof-pub-athena");
  });

  test("end to end: a spoof run's generation, read back by instance, overrides the file on the next plain boot", async () => {
    const root = tempDir();
    try {
      const outcome = await spoofKeys({
        guards: allowed(),
        instance: "rm_twin",
        stateRoot: root,
        names: ["athena"],
        members: IN_HOUSE,
        running: [],
        db: fakeDb(null).deps,
        containers: fakeContainers().deps,
      });
      const persisted = readSpoofGeneration(root, "rm_twin");
      expect(persisted?.generationId).toBe(outcome.generationId);
      const roster = effectiveRoster(FILE, persisted);
      const athena = roster.find((e) => e.name === "athena");
      expect(athena?.identity.publicKeyB64).toBe(persisted?.members.athena?.identity.publicKeyB64 as string);
      expect(athena?.bearer).toBe(persisted?.members.athena?.bearer as string);
      expect(athena?.identity.publicKeyB64).not.toBe("file-pub-athena");
      // A different instance under the same root was never spoofed: its plain
      // boot keeps RM_CREDENTIALS.
      expect(effectiveRoster(FILE, readSpoofGeneration(root, "other-twin"))).toEqual(FILE);
    } finally {
      rmSync(root, { recursive: true, force: true });
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
      athena: {
        name: "athena",
        memberId: "m-athena",
        identity: { publicKeyB64: "pub-a", privateJwk: { kty: "OKP" } },
        bearer: "tok_m-athena_a",
      },
      "robot-money": {
        name: "robot-money",
        memberId: "m-robot-money",
        identity: { publicKeyB64: "pub-r", privateJwk: { kty: "OKP" } },
        bearer: "tok_m-robot-money_r",
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

  test("every named member's bearer is ISSUED, by member id, with the generation id", async () => {
    // A rebound key with the old bearer still active would leave the twin's
    // members unable to authenticate from this host.
    const db = fakeDb(null);
    await rebindSpoofedKeys(generation, db.deps);
    expect(db.tokens.map((t) => [t.memberId, t.bearer]).sort()).toEqual([
      ["m-athena", "tok_m-athena_a"],
      ["m-robot-money", "tok_m-robot-money_r"],
    ]);
    expect(db.tokens.every((t) => t.generationId === "gen-abc")).toBe(true);
  });

  test("all rebinds happen inside ONE fence — a partial rebind is not a state this design has", async () => {
    const db = fakeDb(null);
    await rebindSpoofedKeys(generation, db.deps);
    expect(db.calls.filter((c) => c === "fence:open")).toHaveLength(1);
    const open = db.calls.indexOf("fence:open");
    const close = db.calls.indexOf("fence:close");
    for (const [i, call] of db.calls.entries()) {
      if (call.startsWith("rebind:") || call.startsWith("token:")) {
        expect(i).toBeGreaterThan(open);
        expect(i).toBeLessThan(close);
      }
    }
  });

  test("RERUN: a database already at this generation is NOT rebound again", async () => {
    const db = fakeDb("gen-abc");
    await rebindSpoofedKeys(generation, db.deps);
    expect(db.rebinds).toEqual([]);
    expect(db.tokens).toEqual([]);
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
      athena: {
        name: "athena",
        memberId: "m-athena",
        identity: { publicKeyB64: "pub-a", privateJwk: { kty: "OKP" } },
        bearer: "tok_m-athena_a",
      },
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
          bearer: "tok_m-robot-money_r",
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
    const out = genFile(dir);
    const db = fakeDb(null);
    const containers = fakeContainers();
    try {
      const outcome = await spoofKeys({
        guards: allowed(),
        instance: "rm_twin",
        stateRoot: dir,
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
      expect(db.tokens.map((t) => t.memberId).sort()).toEqual(["m-athena", "m-robot-money"]);
      expect(readSpoofGeneration(dir, "rm_twin")?.generationId).toBe(outcome.generationId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the generation file EXISTS before the rebind transaction opens", async () => {
    // Written after a crashed rebind, the database would hold keys no file
    // records and the members would be permanently unusable.
    const dir = tempDir();
    const out = genFile(dir);
    const db = fakeDb(null);
    let fileWhenFenceOpened = false;
    db.onFenceOpen(() => {
      fileWhenFenceOpened = existsSync(out);
    });
    try {
      await spoofKeys({
        guards: allowed(),
        instance: "rm_twin",
        stateRoot: dir,
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
    const out = genFile(dir);
    try {
      // First run: reaches the commit, then the process dies before (3)/(4).
      const first = await spoofKeys({
        guards: allowed(),
        instance: "rm_twin",
        stateRoot: dir,
        names: [],
        members: IN_HOUSE,
        running: [],
        db: fakeDb(null).deps,
        containers: fakeContainers().deps,
      });
      const persistedKey = readSpoofGeneration(dir, "rm_twin")?.members.athena?.identity.publicKeyB64;

      // The rerun: the database already reports the persisted generation.
      const db2 = fakeDb(first.generationId);
      const containers2 = fakeContainers();
      const second = await spoofKeys({
        guards: allowed(),
        instance: "rm_twin",
        stateRoot: dir,
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
      expect(readSpoofGeneration(dir, "rm_twin")?.generationId).toBe(first.generationId);
      expect(readSpoofGeneration(dir, "rm_twin")?.members.athena?.identity.publicKeyB64).toBe(persistedKey);
      // And the stale container was still replaced — steps (3) and (4) ran.
      expect(containers2.calls).toContain("stop:athena");
      expect(containers2.calls).toContain(`start:athena@${first.generationId}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GATE 'interrupted rebind then rerun': a rerun before the commit rebinds under the SAME generation", async () => {
    const dir = tempDir();
    const out = genFile(dir);
    try {
      const first = writeSpoofGeneration(
        IN_HOUSE.map((m) => ({ name: m.name, memberId: m.memberId })),
        dir,
        "rm_twin",
      );
      const db = fakeDb(null); // the interrupted run never committed
      const outcome = await spoofKeys({
        guards: allowed(),
        instance: "rm_twin",
        stateRoot: dir,
        names: [],
        members: IN_HOUSE,
        running: [],
        db: db.deps,
        containers: fakeContainers().deps,
      });
      expect(outcome.generationId).toBe(first.generationId);
      expect(db.rebinds.map((r) => r.memberId).sort()).toEqual(["m-athena", "m-robot-money"]);
      expect(db.rebinds.every((r) => r.generationId === first.generationId)).toBe(true);
      // The rerun issues the PERSISTED bearers, not freshly minted ones.
      expect(db.tokens.map((t) => t.bearer).sort()).toEqual(
        Object.values(first.members).map((m) => m.bearer).sort(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with no names given, the default membership is every `operator = robotmoney` member", async () => {
    const dir = tempDir();
    const out = genFile(dir);
    try {
      const outcome = await spoofKeys({
        guards: allowed(),
        instance: "rm_twin",
        stateRoot: dir,
        names: [],
        members: [...IN_HOUSE, THIRD_PARTY],
        running: [],
        db: fakeDb(null).deps,
        containers: fakeContainers().deps,
      });
      expect([...outcome.rebound].sort()).toEqual(["athena", "robot-money"]);
      expect(outcome.rebound).not.toContain("outsider");
      expect(Object.keys(readSpoofGeneration(dir, "rm_twin")?.members ?? {})).not.toContain("outsider");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an EXPLICIT name list still never reaches a third party's member — their key is theirs", async () => {
    const dir = tempDir();
    const out = genFile(dir);
    try {
      await expect(
        spoofKeys({
          guards: allowed(),
          instance: "rm_twin",
          stateRoot: dir,
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
    const out = genFile(dir);
    try {
      const outcome = await spoofKeys({
        guards: allowed(),
        instance: "rm_twin",
        stateRoot: dir,
        names: ["athena"],
        members: IN_HOUSE,
        running: [],
        db: fakeDb(null).deps,
        containers: fakeContainers().deps,
      });
      expect(outcome.rebound).toEqual(["athena"]);
      expect(Object.keys(readSpoofGeneration(dir, "rm_twin")?.members ?? {})).toEqual(["athena"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a refused run generates NOTHING — no file, no rebind, no container touched", async () => {
    const dir = tempDir();
    const out = genFile(dir);
    const db = fakeDb(null);
    const containers = fakeContainers();
    try {
      const r = await asyncSpoofRefusal(() =>
        spoofKeys({
          guards: allowed({ rmEnv: "prod" }),
          instance: "rm_twin",
          stateRoot: dir,
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
    const out = genFile(dir);
    try {
      const r = await asyncSpoofRefusal(() =>
        spoofKeys({
          guards: allowed({ credentialPath: out }),
          instance: "rm_twin",
          stateRoot: dir,
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

  test("a `..`-spelled credential path that names the generation file refuses without writing anywhere", async () => {
    const dir = tempDir();
    const out = genFile(dir);
    // A raw string, as RM_CREDENTIALS would carry it: not normalized.
    const dotted = `${dir}/rm_twin/../rm_twin/spoof-generation`;
    try {
      const r = await asyncSpoofRefusal(() =>
        spoofKeys({
          guards: allowed({ credentialPath: dotted }),
          instance: "rm_twin",
          stateRoot: dir,
          names: [],
          members: IN_HOUSE,
          running: [],
          db: fakeDb(null).deps,
          containers: fakeContainers().deps,
        }),
      );
      expect(dotted).not.toBe(out);
      expect(r.reason).toBe("credential_path_collision");
      expect(existsSync(out)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
