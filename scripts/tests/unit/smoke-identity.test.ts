// Unit specification for scripts/lib/smoke-identity.ts — the `deployment_identity`
// row of docs/technical/smoke-production-spec.md §4.2, its read/write seam, the
// two enrollment paths (§5 rehearsal, §9.1 production), and the rehearsal-only
// preparation gate shared by `--migrate`, `--seed` and `--spoof-keys` (§4.3).
//
// TDD RED PHASE (issue #1026, W1 step 2). Every function under test currently
// throws `NOT IMPLEMENTED`; every test here fails today by design and is written
// against the behaviour the module must have once W1.2 lands.
//
// WHY THE STORE IS FAKED. §4.2's write restriction is a database grant, not a
// TypeScript check, and the module's own comment says an implementation must not
// re-implement it in TypeScript. What IS this module's job — the three-way read,
// the enrollment refusals, and the shared gate — is pure logic over the store's
// answers, so the tests drive it through a fake {@link DeploymentIdentityStore}.
// That is also what lets the W1 gates run in CI with no cluster provisioned.
//
// THE THREE-WAY READ IS THE POINT. "enrolled", "absent" and "unreadable" must
// stay three answers all the way to the matrix. Collapsing "I could not read the
// table" into "there is no row" sends an operator to write a row they are not
// permitted to write, so each arm is asserted separately and asserted to be
// distinguishable from the others.
//
// Acceptance gates served (spec §10): W1 — the identity half of the policy
// matrix and the rehearsal-only lifecycle gates; W2 — "`RM_ENV=stage` + typed
// owner password against `deployment_identity = production` refuses"; W3 — the
// `--spoof-keys` guards.
import { describe, expect, test } from "bun:test";
import {
  enrollAsProduction,
  enrollAsRehearsal,
  openDeploymentIdentityStore,
  readIdentityForPolicy,
  requireRehearsalTarget,
  type DeploymentIdentityKind,
  type DeploymentIdentityRead,
  type DeploymentIdentityRow,
  type DeploymentIdentityStore,
  type RehearsalOnlyPreparation,
} from "../../lib/smoke-identity.ts";

const REMOTE_URL = "postgres://rm_owner@db.example.invalid:5432/robotmoney";

/** A store whose answers the test controls, recording every write it is asked to make. */
function fakeStore(read: DeploymentIdentityRead): DeploymentIdentityStore & {
  readonly writes: { kind: DeploymentIdentityKind; note: string | null }[];
  closed: boolean;
} {
  const writes: { kind: DeploymentIdentityKind; note: string | null }[] = [];
  const store = {
    writes,
    closed: false,
    read(): Promise<DeploymentIdentityRead> {
      return Promise.resolve(read);
    },
    write(kind: DeploymentIdentityKind, note: string | null): Promise<DeploymentIdentityRow> {
      writes.push({ kind, note });
      return Promise.resolve({ kind, writtenAt: "2026-09-23T00:00:00.000Z", writtenBy: "rm_owner", note });
    },
    close(): Promise<void> {
      store.closed = true;
      return Promise.resolve();
    },
  };
  return store;
}

const enrolled = (kind: DeploymentIdentityKind): DeploymentIdentityRead => ({
  state: "enrolled",
  row: { kind, writtenAt: "2026-09-20T12:00:00.000Z", writtenBy: "rm_owner", note: null },
});

describe("openDeploymentIdentityStore — §4.2, configuration errors are named as configuration errors", () => {
  test("an empty connection URL refuses up front rather than deferring to a connection error at read time", async () => {
    expect(() => openDeploymentIdentityStore({ databaseUrl: "", role: "rm_app", writable: false })).toThrow(
      /connection|url/i,
    );
  });

  test("an unparseable connection URL refuses up front for the same reason", () => {
    expect(() =>
      openDeploymentIdentityStore({ databaseUrl: "not a url at all", role: "rm_app", writable: false }),
    ).toThrow(/connection|url/i);
  });

  test("asking for a writable store under a runtime role refuses and names rm_owner", () => {
    expect(() => openDeploymentIdentityStore({ databaseUrl: REMOTE_URL, role: "rm_app", writable: true })).toThrow(
      /rm_owner/,
    );
  });

  test("a read-only store under a runtime role opens — preflight check 5 reads the row under the container's own credential", () => {
    const store = openDeploymentIdentityStore({ databaseUrl: REMOTE_URL, role: "rm_app", writable: false });
    expect(typeof store.read).toBe("function");
    expect(typeof store.write).toBe("function");
    expect(typeof store.close).toBe("function");
  });

  test("a writable store as rm_owner opens", () => {
    const store = openDeploymentIdentityStore({ databaseUrl: REMOTE_URL, role: "rm_owner", writable: true });
    expect(typeof store.write).toBe("function");
  });
});

describe("readIdentityForPolicy — the three-way read must reach the matrix as three answers", () => {
  test("an enrolled production row reduces to the literal `production`", async () => {
    expect(await readIdentityForPolicy(fakeStore(enrolled("production")))).toBe("production");
  });

  test("an enrolled rehearsal row reduces to the literal `rehearsal`", async () => {
    expect(await readIdentityForPolicy(fakeStore(enrolled("rehearsal")))).toBe("rehearsal");
  });

  test("a table that exists with no row reduces to null — an un-enrolled database, whose fix is to enroll it", async () => {
    expect(await readIdentityForPolicy(fakeStore({ state: "absent" }))).toBeNull();
  });

  test("a missing or unreadable table reduces to `unreadable` — a different fix: the credential cannot see the table", async () => {
    const value = await readIdentityForPolicy(fakeStore({ state: "unreadable", reason: "permission denied" }));
    expect(value).toBe("unreadable");
  });

  test("absent and unreadable never collapse into one another", async () => {
    const absent = await readIdentityForPolicy(fakeStore({ state: "absent" }));
    const unreadable = await readIdentityForPolicy(fakeStore({ state: "unreadable", reason: "no such table" }));
    expect(absent).not.toBe(unreadable);
  });

  test("the read reports and never refuses: an unreadable table resolves rather than throwing", async () => {
    await expect(readIdentityForPolicy(fakeStore({ state: "unreadable", reason: "boom" }))).resolves.toBe("unreadable");
  });
});

describe("enrollAsRehearsal — §4.2/§5, the write that a dump restore must perform", () => {
  test("writes exactly `rehearsal`, carrying the caller's provenance note", async () => {
    const store = fakeStore({ state: "absent" });
    const row = await enrollAsRehearsal(store, { note: "restored from prod-2026-09-20.dump", remoteAcknowledged: true });
    expect(row.kind).toBe("rehearsal");
    expect(store.writes).toEqual([{ kind: "rehearsal", note: "restored from prod-2026-09-20.dump" }]);
  });

  test("overwrites the `production` row a production dump carried in — that overwrite is the whole point", async () => {
    const store = fakeStore(enrolled("production"));
    const row = await enrollAsRehearsal(store, { note: "twin restore", remoteAcknowledged: true });
    expect(row.kind).toBe("rehearsal");
    expect(store.writes).toEqual([{ kind: "rehearsal", note: "twin restore" }]);
  });

  test("a remote target without the operator's explicit acknowledgement refuses, and writes nothing", async () => {
    const store = openDeploymentIdentityStore({ databaseUrl: REMOTE_URL, role: "rm_owner", writable: true });
    await expect(enrollAsRehearsal(store, { note: null, remoteAcknowledged: false })).rejects.toThrow(
      /acknowledg|confirm/i,
    );
  });

  test("a store that was not opened writable refuses", async () => {
    const readOnly = openDeploymentIdentityStore({ databaseUrl: REMOTE_URL, role: "rm_app", writable: false });
    await expect(enrollAsRehearsal(readOnly, { note: null, remoteAcknowledged: true })).rejects.toThrow(/rm_owner|writ/i);
  });

  test("the returned row records who wrote it, for the incident question `since when, and by whom`", async () => {
    const store = fakeStore({ state: "absent" });
    const row = await enrollAsRehearsal(store, { note: null, remoteAcknowledged: true });
    expect(row.writtenBy).toBe("rm_owner");
    expect(Number.isNaN(Date.parse(row.writtenAt))).toBe(false);
  });
});

describe("enrollAsProduction — §9.1 step 3, written once, gated four ways", () => {
  test("RM_ENV that is not exactly `prod` refuses and writes nothing", async () => {
    const store = fakeStore({ state: "absent" });
    await expect(enrollAsProduction(store, { rmEnv: "stage", confirmed: true, note: null })).rejects.toThrow(/prod/);
    expect(store.writes).toEqual([]);
  });

  test("an unset RM_ENV refuses — enrollment is never reachable by forgetting to export", async () => {
    const store = fakeStore({ state: "absent" });
    await expect(enrollAsProduction(store, { rmEnv: undefined, confirmed: true, note: null })).rejects.toThrow(/RM_ENV/);
    expect(store.writes).toEqual([]);
  });

  test("an unconfirmed invocation refuses rather than defaulting to yes", async () => {
    const store = fakeStore({ state: "absent" });
    await expect(enrollAsProduction(store, { rmEnv: "prod", confirmed: false, note: null })).rejects.toThrow(
      /confirm|y\/n/i,
    );
    expect(store.writes).toEqual([]);
  });

  test("an un-enrolled database under prod, confirmed, is enrolled as production", async () => {
    const store = fakeStore({ state: "absent" });
    const row = await enrollAsProduction(store, { rmEnv: "prod", confirmed: true, note: "initialization step 3" });
    expect(row.kind).toBe("production");
    expect(store.writes).toEqual([{ kind: "production", note: "initialization step 3" }]);
  });

  test("a database already enrolled as production is reported as a no-op and is NOT rewritten", async () => {
    const store = fakeStore(enrolled("production"));
    const row = await enrollAsProduction(store, { rmEnv: "prod", confirmed: true, note: null });
    expect(row.kind).toBe("production");
    expect(store.writes).toEqual([]);
  });

  test("promoting a rehearsal database to production refuses and names both kinds", async () => {
    const store = fakeStore(enrolled("rehearsal"));
    await expect(enrollAsProduction(store, { rmEnv: "prod", confirmed: true, note: null })).rejects.toThrow(
      /rehearsal/,
    );
    expect(store.writes).toEqual([]);
  });

  test("a store that is not writable as rm_owner refuses", async () => {
    const readOnly = openDeploymentIdentityStore({ databaseUrl: REMOTE_URL, role: "rm_app", writable: false });
    await expect(enrollAsProduction(readOnly, { rmEnv: "prod", confirmed: true, note: null })).rejects.toThrow(
      /rm_owner|writ/i,
    );
  });
});

describe("requireRehearsalTarget — §4.3, the floor under --migrate, --seed and --spoof-keys", () => {
  const ALL: readonly RehearsalOnlyPreparation[] = ["migrate", "seed", "spoof-keys"];

  for (const preparation of ALL) {
    test(`${preparation} on a correctly enrolled rehearsal target under stage is allowed with no prompt`, () => {
      expect(
        requireRehearsalTarget({ preparation, rmEnv: "stage", identity: "rehearsal", explicitlyRequested: true }),
      ).toEqual({ allow: true });
    });
  }

  for (const preparation of ALL) {
    test(`${preparation} refuses under RM_ENV=prod whatever the identity says — a production run never prepares`, () => {
      for (const identity of ["production", "rehearsal", null, "unreadable"] as const) {
        const result = requireRehearsalTarget({ preparation, rmEnv: "prod", identity, explicitlyRequested: true });
        expect(result.allow).toBe(false);
        if (result.allow) throw new Error("expected a refusal");
        expect(result.reason).toContain(preparation);
        expect(result.reason).toContain("prod");
      }
    });
  }

  test("a production identity refuses under stage, naming the preparation and what the target says", () => {
    const result = requireRehearsalTarget({
      preparation: "seed",
      rmEnv: "stage",
      identity: "production",
      explicitlyRequested: true,
    });
    expect(result.allow).toBe(false);
    if (result.allow) throw new Error("expected a refusal");
    expect(result.reason).toContain("seed");
    expect(result.reason).toContain("production");
  });

  test("an un-enrolled database refuses: absence of a row is not rehearsal", () => {
    const result = requireRehearsalTarget({
      preparation: "migrate",
      rmEnv: "stage",
      identity: null,
      explicitlyRequested: true,
    });
    expect(result.allow).toBe(false);
    if (result.allow) throw new Error("expected a refusal");
    expect(result.reason.toLowerCase()).toContain("not enrolled");
  });

  test("an unreadable identity refuses with its own text: no evidence, no preparation", () => {
    const result = requireRehearsalTarget({
      preparation: "spoof-keys",
      rmEnv: "stage",
      identity: "unreadable",
      explicitlyRequested: true,
    });
    expect(result.allow).toBe(false);
    if (result.allow) throw new Error("expected a refusal");
    expect(result.reason.toLowerCase()).toContain("unreadable");
  });

  test("the absent refusal and the unreadable refusal do not share text — they have different fixes", () => {
    const absent = requireRehearsalTarget({
      preparation: "seed",
      rmEnv: "stage",
      identity: null,
      explicitlyRequested: true,
    });
    const unreadable = requireRehearsalTarget({
      preparation: "seed",
      rmEnv: "stage",
      identity: "unreadable",
      explicitlyRequested: true,
    });
    expect(absent.allow).toBe(false);
    expect(unreadable.allow).toBe(false);
    if (absent.allow || unreadable.allow) throw new Error("expected refusals");
    expect(absent.reason).not.toBe(unreadable.reason);
  });

  for (const preparation of ALL) {
    test(`${preparation} refuses when it was not explicitly requested — no mode may imply a preparation`, () => {
      const result = requireRehearsalTarget({
        preparation,
        rmEnv: "stage",
        identity: "rehearsal",
        explicitlyRequested: false,
      });
      expect(result.allow).toBe(false);
      if (result.allow) throw new Error("expected a refusal");
      expect(result.reason.toLowerCase()).toContain("explicit");
    });
  }

  test("an unset RM_ENV is stage policy here too, so a correctly enrolled rehearsal target still prepares", () => {
    const result = requireRehearsalTarget({
      preparation: "seed",
      rmEnv: undefined,
      identity: "rehearsal",
      explicitlyRequested: true,
    });
    expect(result.allow).toBe(true);
  });

  test("an unknown RM_ENV value refuses rather than being read as stage", () => {
    const result = requireRehearsalTarget({
      preparation: "seed",
      rmEnv: "smoke",
      identity: "rehearsal",
      explicitlyRequested: true,
    });
    expect(result.allow).toBe(false);
    if (result.allow) throw new Error("expected a refusal");
    expect(result.reason).toContain("smoke");
  });
});
