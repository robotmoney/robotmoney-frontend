// THE DATABASE HALF OF `--spoof-keys` — backend/scripts/spoof-rebind.ts
// (smoke-production-spec.md §6.4, §2; D52, D55 (6); issue #1026 criteria 35,
// 146, 147).
//
// Driven through `spoofRebind`, the function the `prepare (spoof-keys)` child
// runs, logged in AS rm_owner on a database of each test's own (a template
// copy, never a DELETE to reset), enrolled `rehearsal` by the test's superuser
// the way a `--local blank|dump` preparation leaves it. What each case pins:
//
//   - DEFAULT MEMBERSHIP is every `operator = robotmoney` member; a third
//     party's member is never spoofed, named or not.
//   - THE EXISTING KEY MECHANISM: the old active key rows are superseded with
//     `active = false` and kept; the new active row carries the generation's
//     public key, its generation id and ONLY the hash of its bearer. No row is
//     ever deleted.
//   - THE BEARER AUTHENTICATES through the API's own lookup (memberIdForToken),
//     and the member's previous bearer stops authenticating in the same commit.
//   - RESUMABLE: a rerun after the commit rebinds nothing; a run whose fenced
//     transaction aborted leaves the database untouched and the persisted
//     generation in place, and the rerun rebinds under that SAME generation.
//   - THE GUARDS refuse on the target's own enrollment before anything is
//     written.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { config } from "../src/config.ts";
import { sql } from "../src/db/client.ts";
import { withMutationFence } from "../src/db/target-lock.ts";
import { hashKey } from "../src/lib/keys.ts";
import { memberIdForToken } from "../src/swarm/domain.ts";
import { spoofRebind, spoofRebindDeps } from "../scripts/spoof-rebind.ts";
import { readSpoofGeneration, spoofKeys, SpoofKeysRefusal, writeSpoofGeneration } from "../../scripts/lib/swarm/spoof-keys.ts";
import { instancePaths } from "../../scripts/lib/smoke-state.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

useCleanDatabasePerTest(import.meta.file);

const OWNER_PASSWORD = randomBytes(18).toString("base64url");
let ownerCanLogin = true;
const roots: string[] = [];

beforeAll(async () => {
  const [row] = await sql<{ rolcanlogin: boolean }[]>`SELECT rolcanlogin FROM pg_roles WHERE rolname = 'rm_owner'`;
  ownerCanLogin = row?.rolcanlogin ?? true;
  await sql.unsafe(`ALTER ROLE rm_owner LOGIN PASSWORD '${OWNER_PASSWORD}'`);
});

afterAll(async () => {
  await sql.unsafe(`ALTER ROLE rm_owner ${ownerCanLogin ? "LOGIN" : "NOLOGIN"} PASSWORD NULL`);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** An rm_owner login to THIS test's own database. */
async function ownerUrl(): Promise<string> {
  const [row] = await sql<{ db: string }[]>`SELECT current_database() AS db`;
  const url = new URL(config.databaseUrl);
  url.pathname = `/${row!.db}`;
  url.username = "rm_owner";
  url.password = encodeURIComponent(OWNER_PASSWORD);
  return url.toString();
}

function stateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "rm-spoof-rebind-"));
  roots.push(root);
  return root;
}

const INSTANCE = "rm_it_spoof";

/** Two in-house members and a third party's, each with one active key and bearer. */
async function seat(): Promise<{ inHouse: string[]; outsider: string; oldBearers: Record<string, string> }> {
  const tag = randomBytes(3).toString("hex");
  const members = [
    { id: `m-athena-${tag}`, handle: `athena-${tag}`, operator: "robotmoney" },
    { id: `m-robot-${tag}`, handle: `robot-money-${tag}`, operator: "robotmoney" },
    { id: `m-acme-${tag}`, handle: `outsider-${tag}`, operator: "acme" },
  ];
  const oldBearers: Record<string, string> = {};
  for (const m of members) {
    await sql`INSERT INTO swarm_members (id, handle, name, status, operator, role) VALUES (${m.id}, ${m.handle}, ${m.handle}, 'active', ${m.operator}, 'member')`;
    oldBearers[m.id] = `tok_${m.id}_original`;
    await sql`INSERT INTO swarm_member_keys (member_id, public_key, active, token_hash) VALUES (${m.id}, ${`orig-pub-${m.id}`}, true, ${hashKey(oldBearers[m.id]!)})`;
  }
  return { inHouse: [members[0]!.handle, members[1]!.handle], outsider: members[2]!.handle, oldBearers };
}

async function enroll(kind: "rehearsal" | "production"): Promise<void> {
  await sql`INSERT INTO deployment_identity (kind, note) VALUES (${kind}, 'spoof-rebind test')`;
}

type KeyRow = { member_id: string; public_key: string; active: boolean; token_hash: string | null; spoof_generation_id: string | null };
const keysOf = (memberId: string) =>
  sql<KeyRow[]>`SELECT member_id, public_key, active, token_hash, spoof_generation_id FROM swarm_member_keys WHERE member_id = ${memberId} ORDER BY id`;
const keyCount = async () => Number((await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM swarm_member_keys`)[0]!.n);

const run = async (root: string, names: readonly string[], over: Partial<Parameters<typeof spoofRebind>[0]> = {}) =>
  spoofRebind({
    ownerUrl: await ownerUrl(),
    instance: INSTANCE,
    stateRoot: root,
    names,
    flagExplicit: true,
    rmEnv: "stage",
    credentialPath: null,
    ...over,
  });

describe("the rebind, as rm_owner, through the existing key mechanism", () => {
  test("named in-house members move to the generation: old keys superseded and kept, new key + bearer hash + generation id", async () => {
    await enroll("rehearsal");
    const { inHouse, oldBearers } = await seat();
    const root = stateRoot();
    const before = await keyCount();
    const outcome = await run(root, inHouse);
    expect(outcome.resumed).toBe(false);
    expect([...outcome.rebound].sort()).toEqual([...inHouse].sort());

    const generation = readSpoofGeneration(root, INSTANCE)!;
    expect(generation.generationId).toBe(outcome.generationId);
    for (const handle of inHouse) {
      const member = generation.members[handle]!;
      const rows = await keysOf(member.memberId);
      // Nothing deleted: the original row is still there, retired.
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ public_key: `orig-pub-${member.memberId}`, active: false, spoof_generation_id: null });
      // The new active row: the generation's key, id, and ONLY the bearer's hash.
      expect(rows[1]).toMatchObject({
        public_key: member.identity.publicKeyB64,
        active: true,
        token_hash: hashKey(member.bearer),
        spoof_generation_id: generation.generationId,
      });
      expect(JSON.stringify(rows)).not.toContain(member.bearer);
      // The API's own bearer lookup: the new bearer authenticates as the
      // member, the one it replaced no longer does.
      expect(await memberIdForToken(member.bearer)).toBe(member.memberId);
      expect(await memberIdForToken(oldBearers[member.memberId]!)).toBeNull();
    }
    // Two rows added, none removed.
    expect(await keyCount()).toBe(before + inHouse.length);
  });

  test("with no names, the default is every member whose operator is robotmoney — never a third party's", async () => {
    await enroll("rehearsal");
    const { outsider } = await seat();
    const root = stateRoot();
    const outcome = await run(root, []);
    const inHouse = (await sql<{ handle: string }[]>`SELECT handle FROM swarm_members WHERE operator = 'robotmoney'`).map((r) => r.handle);
    expect([...outcome.rebound].sort()).toEqual([...inHouse].sort());
    expect(outcome.rebound).not.toContain(outsider);
    const outsiderKeys = await sql<KeyRow[]>`SELECT k.* FROM swarm_member_keys k JOIN swarm_members m ON m.id = k.member_id WHERE m.handle = ${outsider}`;
    expect(outsiderKeys.map((k) => k.spoof_generation_id)).toEqual([null]);
  });

  test("naming a third party's member refuses before anything is written", async () => {
    await enroll("rehearsal");
    const { outsider } = await seat();
    const root = stateRoot();
    const before = await keyCount();
    await expect(run(root, [outsider])).rejects.toThrow(/third party/);
    expect(existsSync(instancePaths(root, INSTANCE).spoofGenerationFile)).toBe(false);
    expect(await keyCount()).toBe(before);
  });
});

describe("recoverable, not atomic: every rerun ends on the persisted generation (criterion 147)", () => {
  test("a rerun after the commit finds the database AT the generation and rebinds nothing", async () => {
    await enroll("rehearsal");
    const { inHouse } = await seat();
    const root = stateRoot();
    const first = await run(root, inHouse);
    const after = await keyCount();
    const second = await run(root, inHouse);
    expect(second.generationId).toBe(first.generationId);
    expect(second.resumed).toBe(true);
    expect(second.rebound).toEqual([]);
    expect(await keyCount()).toBe(after);
  });

  test("an interrupted rebind (the fenced transaction aborts) leaves the database untouched; the rerun rebinds under the SAME generation", async () => {
    await enroll("rehearsal");
    const { inHouse, oldBearers } = await seat();
    const root = stateRoot();
    const url = await ownerUrl();
    const owner = postgres(url, { max: 1, onnotice: () => {} });
    const before = await keyCount();
    try {
      // The real statements inside the real fence, then the process "dies"
      // before the commit: the fence's transaction aborts.
      const deps = spoofRebindDeps({ ownerUrl: url, reader: owner, withMutationFence });
      const members = (await sql<{ id: string; handle: string }[]>`SELECT id, handle FROM swarm_members WHERE handle = ANY(${[...inHouse]})`)
        .map((m) => ({ name: m.handle, memberId: m.id, operator: "robotmoney" }));
      await expect(
        spoofKeys({
          guards: { rmEnv: "stage", deploymentIdentity: "rehearsal", hasOwnerCredential: true, flagExplicit: true, credentialPath: null },
          instance: INSTANCE,
          stateRoot: root,
          names: inHouse,
          members,
          db: {
            ...deps,
            withFencedTransaction: (fn) => deps.withFencedTransaction(async () => {
              await fn();
              throw new Error("killed before the commit");
            }),
          },
        }),
      ).rejects.toThrow("killed before the commit");
    } finally {
      await owner.end({ timeout: 5 });
    }
    // The generation was persisted FIRST; the database was not touched.
    const persisted = readSpoofGeneration(root, INSTANCE)!;
    expect(persisted).not.toBeNull();
    expect(await keyCount()).toBe(before);
    for (const id of Object.keys(oldBearers)) {
      const rows = await keysOf(id);
      expect(rows.every((r) => r.spoof_generation_id === null)).toBe(true);
    }
    // The rerun reads the SAME generation back and completes it.
    const rerun = await run(root, inHouse);
    expect(rerun.generationId).toBe(persisted.generationId);
    expect(rerun.resumed).toBe(false);
    for (const member of Object.values(persisted.members)) {
      const active = (await keysOf(member.memberId)).filter((r) => r.active);
      expect(active).toEqual([expect.objectContaining({ public_key: member.identity.publicKeyB64, spoof_generation_id: persisted.generationId })]);
      expect(await memberIdForToken(member.bearer)).toBe(member.memberId);
    }
  });

  test("a generation already on disk is reused, never replaced by a second one", async () => {
    await enroll("rehearsal");
    const { inHouse } = await seat();
    const root = stateRoot();
    const members = (await sql<{ id: string; handle: string }[]>`SELECT id, handle FROM swarm_members WHERE handle = ANY(${[...inHouse]})`)
      .map((m) => ({ name: m.handle, memberId: m.id }));
    const written = writeSpoofGeneration(members, root, INSTANCE);
    const outcome = await run(root, inHouse);
    expect(outcome.generationId).toBe(written.generationId);
  });
});

describe("the §6.4 guards refuse on the target's own enrollment, before anything is written", () => {
  const refusalOf = async (p: Promise<unknown>): Promise<SpoofKeysRefusal> => {
    try {
      await p;
    } catch (err) {
      if (err instanceof SpoofKeysRefusal) return err;
      throw err;
    }
    throw new Error("expected a SpoofKeysRefusal");
  };

  test("deployment_identity = production refuses, whatever RM_ENV says", async () => {
    await enroll("production");
    const { inHouse } = await seat();
    const root = stateRoot();
    const before = await keyCount();
    expect((await refusalOf(run(root, inHouse))).reason).toBe("identity_not_rehearsal");
    expect(existsSync(instancePaths(root, INSTANCE).spoofGenerationFile)).toBe(false);
    expect(await keyCount()).toBe(before);
  });

  test("an unenrolled target refuses — unknown is not rehearsal", async () => {
    const { inHouse } = await seat();
    expect((await refusalOf(run(stateRoot(), inHouse))).reason).toBe("identity_not_rehearsal");
  });

  test("RM_ENV = prod refuses", async () => {
    await enroll("rehearsal");
    const { inHouse } = await seat();
    expect((await refusalOf(run(stateRoot(), inHouse, { rmEnv: "prod" }))).reason).toBe("rm_env_prod");
  });

  test("a flag that was not explicit refuses", async () => {
    await enroll("rehearsal");
    const { inHouse } = await seat();
    expect((await refusalOf(run(stateRoot(), inHouse, { flagExplicit: false }))).reason).toBe("flag_not_explicit");
  });

  test("the generation would land on the credential file: refuses", async () => {
    await enroll("rehearsal");
    const { inHouse } = await seat();
    const root = stateRoot();
    const collision = instancePaths(root, INSTANCE).spoofGenerationFile;
    expect((await refusalOf(run(root, inHouse, { credentialPath: collision }))).reason).toBe("credential_path_collision");
  });
});
