// Token PROVISIONING — the write half of the automation-token store (issue #1026
// W4, criteria 31, 35, 96).
//
// AUTHORITY: docs/technical/smoke-production-spec.md §2, §3, §5 and §9.1 step 5,
// and D55 (6).
//
//   §3: "Every service token is issued by the API's own automation-token store:
//        a row holding the token's hash and its rights, written by the same
//        authorized preparation that writes `deployment_identity` … Each
//        instance holds its own tokens, so provisioning one never invalidates
//        another's. Rotation is a re-provision and a container restart."
//   §2: "Every mutation (… token provisioning, identity write) runs in a
//        transaction that first takes `pg_advisory_xact_lock` on the same key".
//   D55 (6): re-provisioning replaces a holder's row in place, never a DELETE.
//
// Driven through backend/scripts/provision-tokens.ts — the exported function
// prod-init calls, and the direct-run process `bun smoke` starts — against a
// database of this file's own, bootstrapped from the snapshot AS rm_owner, so
// the table's grants are the snapshot's and the write is the owner's.
// automation-token.test.ts owns the read side (lookup, rights on routes).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { config } from "../src/config.ts";
import { sql } from "../src/db/client.ts";
import { HOLDER_RIGHTS } from "../src/db/automation-tokens.ts";
import { bootstrapBlankDatabase, loadSnapshot } from "../src/db/schema-snapshot.ts";
import { acquireTargetLock, readTargetState, withMutationFence } from "../src/db/target-lock.ts";
import { hashKey } from "../src/lib/keys.ts";
import { provisionServiceTokens } from "../scripts/provision-tokens.ts";
import { instancePaths, SERVICE_TOKEN_HOLDERS } from "../../scripts/lib/smoke-state.ts";

const OWNER_PASSWORD = randomBytes(18).toString("base64url");
const READER_PASSWORD = randomBytes(18).toString("base64url");
let ownerCanLogin = true;
let readerCanLogin = true;
const roots: string[] = [];

function urlFor(database: string, role?: { name: string; password: string }): string {
  const url = new URL(config.databaseUrl);
  url.pathname = `/${database}`;
  if (role) {
    url.username = role.name;
    url.password = encodeURIComponent(role.password);
  }
  return url.toString();
}
const OWNER = { name: "rm_owner", password: OWNER_PASSWORD };

beforeAll(async () => {
  const rows = await sql<{ rolname: string; rolcanlogin: boolean }[]>`
    SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname IN ('rm_owner', 'rm_readonly')`;
  ownerCanLogin = rows.find((r) => r.rolname === "rm_owner")?.rolcanlogin ?? true;
  readerCanLogin = rows.find((r) => r.rolname === "rm_readonly")?.rolcanlogin ?? true;
  await sql.unsafe(`ALTER ROLE rm_owner LOGIN PASSWORD '${OWNER_PASSWORD}'`);
  await sql.unsafe(`ALTER ROLE rm_readonly LOGIN PASSWORD '${READER_PASSWORD}'`);
});

afterAll(async () => {
  await sql.unsafe(`ALTER ROLE rm_owner ${ownerCanLogin ? "LOGIN" : "NOLOGIN"} PASSWORD NULL`);
  await sql.unsafe(`ALTER ROLE rm_readonly ${readerCanLogin ? "LOGIN" : "NOLOGIN"} PASSWORD NULL`);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A database of this test's own, bootstrapped from the snapshot as rm_owner, dropped after. */
async function withDatabase(body: (db: { name: string; admin: postgres.Sql<{}> }) => Promise<void>): Promise<void> {
  const name = `rm_tokens_${randomBytes(4).toString("hex")}`;
  const maintenance = postgres(urlFor("postgres"), { max: 1, onnotice: () => {} });
  await maintenance.unsafe(`CREATE DATABASE ${name} OWNER rm_owner`);
  const admin = postgres(urlFor(name), { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe("CREATE EXTENSION IF NOT EXISTS pgcrypto");
    const owner = postgres(urlFor(name, OWNER), { max: 1, onnotice: () => {} });
    try {
      await bootstrapBlankDatabase(owner, await loadSnapshot());
    } finally {
      await owner.end({ timeout: 5 });
    }
    await body({ name, admin });
  } finally {
    await admin.end({ timeout: 5 });
    await maintenance.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await maintenance.end({ timeout: 5 });
  }
}

/** A state root outside every checkout, with one instance's token directories. */
function stateFor(instance: string) {
  const root = mkdtempSync(join(tmpdir(), "rm-tokens-"));
  roots.push(root);
  return { root, paths: instancePaths(root, instance, { create: true }) };
}

type Row = { instance: string; holder: string; token_hash: string; rights: string[]; created_by: string };
const rowsOf = (admin: postgres.Sql<{}>) =>
  admin<Row[]>`SELECT instance, holder, token_hash, rights, created_by FROM automation_tokens ORDER BY instance, holder`;
const secretOf = (file: string) => readFileSync(file, "utf8").trim();

describe("provisioning stores a hash and the holder's rights, and delivers the secret as the holder's file", () => {
  test("three holders, one fenced rm_owner transaction: HOLDER_RIGHTS, hash only, files 0600 in 0700 directories", async () => {
    await withDatabase(async ({ name, admin }) => {
      const { paths } = stateFor("rm_it_tokens");
      const result = await provisionServiceTokens({ ownerUrl: urlFor(name, OWNER), instance: "rm_it_tokens", tokenFiles: paths.tokenFiles });
      expect(result.holders).toEqual([...SERVICE_TOKEN_HOLDERS]);

      const rows = await rowsOf(admin);
      expect(rows.map((r) => r.holder).sort()).toEqual([...SERVICE_TOKEN_HOLDERS].sort());
      for (const row of rows) {
        const holder = row.holder as (typeof SERVICE_TOKEN_HOLDERS)[number];
        // Rights come from HOLDER_RIGHTS, nothing more (scheduler spec §7).
        expect([...row.rights].sort()).toEqual([...HOLDER_RIGHTS[holder]].sort());
        // Written by the owner, inside provisioning — not by the test's superuser.
        expect(row.created_by).toBe("rm_owner");
        const file = paths.tokenFiles[holder];
        const secret = secretOf(file);
        expect(secret).toMatch(/^rmat_/);
        // The row holds the hash of the file's secret and never the secret.
        expect(row.token_hash).toBe(hashKey(secret));
        expect(JSON.stringify(row)).not.toContain(secret);
        expect(statSync(file).mode & 0o777).toBe(0o600);
        expect(statSync(paths.tokenDirs[holder]).mode & 0o777).toBe(0o700);
        // Its directory holds its token and nothing else: no staged leftover.
        expect(readdirSync(paths.tokenDirs[holder])).toEqual(["token"]);
      }
      // Three distinct secrets: no holder's file validates as another's.
      const hashes = new Set(rows.map((r) => r.token_hash));
      expect(hashes.size).toBe(3);
    });
  }, 60_000);

  test("a file alone grants nothing: a secret that matches no row is refused like a forged one", async () => {
    await withDatabase(async ({ name, admin }) => {
      const { paths } = stateFor("rm_it_forged");
      writeFileSync(paths.tokenFiles.operator, `rmat_${randomBytes(32).toString("base64url")}\n`, { mode: 0o600 });
      const forged = secretOf(paths.tokenFiles.operator);
      const hits = await admin`SELECT 1 FROM automation_tokens WHERE token_hash = ${hashKey(forged)}`;
      expect(hits.length).toBe(0);
      // Red control on the same database: a provisioned file does match.
      await provisionServiceTokens({ ownerUrl: urlFor(name, OWNER), instance: "rm_it_forged", tokenFiles: paths.tokenFiles, holders: ["operator"] });
      const real = await admin`SELECT 1 FROM automation_tokens WHERE token_hash = ${hashKey(secretOf(paths.tokenFiles.operator))}`;
      expect(real.length).toBe(1);
    });
  }, 60_000);
});

describe("re-provisioning replaces one holder's row in place (D55 (6)) and leaves every other token valid", () => {
  test("the old secret stops matching, the other holders and the other instance are untouched, and no row was deleted", async () => {
    await withDatabase(async ({ name, admin }) => {
      const a = stateFor("rm_it_a");
      const b = stateFor("rm_it_b");
      await provisionServiceTokens({ ownerUrl: urlFor(name, OWNER), instance: "rm_it_a", tokenFiles: a.paths.tokenFiles });
      await provisionServiceTokens({ ownerUrl: urlFor(name, OWNER), instance: "rm_it_b", tokenFiles: b.paths.tokenFiles });
      const before = new Map((await rowsOf(admin)).map((r) => [`${r.instance}/${r.holder}`, r.token_hash]));
      const oldScheduler = secretOf(a.paths.tokenFiles["system-scheduler"]);

      await provisionServiceTokens({
        ownerUrl: urlFor(name, OWNER),
        instance: "rm_it_a",
        tokenFiles: a.paths.tokenFiles,
        holders: ["system-scheduler"],
      });

      // In place: still exactly one row per (instance, holder), the rotated one
      // carrying the new hash — an upsert, never a delete and a second insert.
      const after = await rowsOf(admin);
      expect(after.length).toBe(6);
      const newScheduler = secretOf(a.paths.tokenFiles["system-scheduler"]);
      expect(newScheduler).not.toBe(oldScheduler);
      // The old token is rejected on its next lookup: no row carries its hash.
      expect((await admin`SELECT 1 FROM automation_tokens WHERE token_hash = ${hashKey(oldScheduler)}`).length).toBe(0);
      expect((await admin`SELECT 1 FROM automation_tokens WHERE token_hash = ${hashKey(newScheduler)}`).length).toBe(1);
      for (const row of after) {
        const key = `${row.instance}/${row.holder}`;
        if (key === "rm_it_a/system-scheduler") expect(row.token_hash).not.toBe(before.get(key));
        else expect(row.token_hash).toBe(before.get(key)!);
      }
      // Every other file still validates.
      for (const [paths, instance] of [[a.paths, "rm_it_a"], [b.paths, "rm_it_b"]] as const) {
        for (const holder of SERVICE_TOKEN_HOLDERS) {
          const hit = await admin<{ instance: string }[]>`SELECT instance FROM automation_tokens WHERE token_hash = ${hashKey(secretOf(paths.tokenFiles[holder]))}`;
          expect(hit.map((h) => h.instance)).toEqual([instance]);
        }
      }
    });
  }, 60_000);

  test("a failed provisioning renames nothing: every holder keeps its old row and file, and no staged file is left", async () => {
    await withDatabase(async ({ name, admin }) => {
      const { paths } = stateFor("rm_it_abort");
      await provisionServiceTokens({ ownerUrl: urlFor(name, OWNER), instance: "rm_it_abort", tokenFiles: paths.tokenFiles });
      const before = Object.fromEntries(SERVICE_TOKEN_HOLDERS.map((h) => [h, secretOf(paths.tokenFiles[h])]));
      // An owner URL whose password is wrong fails before the fence commits.
      await expect(
        provisionServiceTokens({ ownerUrl: urlFor(name, { name: "rm_owner", password: "wrong" }), instance: "rm_it_abort", tokenFiles: paths.tokenFiles }),
      ).rejects.toThrow();
      for (const holder of SERVICE_TOKEN_HOLDERS) {
        expect(secretOf(paths.tokenFiles[holder])).toBe(before[holder]!);
        expect(readdirSync(paths.tokenDirs[holder])).toEqual(["token"]);
        expect((await admin`SELECT 1 FROM automation_tokens WHERE token_hash = ${hashKey(before[holder]!)}`).length).toBe(1);
      }
    });
  }, 60_000);
});

describe("provisioning is a fenced mutation — a competitor's fence holds it until it commits (§2, criterion 35)", () => {
  test("no row is written while the competitor holds the fence; all three land after it commits", async () => {
    await withDatabase(async ({ name, admin }) => {
      const { paths } = stateFor("rm_it_fence");
      const order: string[] = [];
      const competitor = withMutationFence({ databaseUrl: urlFor(name), label: "competitor" }, async (tx) => {
        order.push("competitor:start");
        await tx`SELECT pg_sleep(0.8)`;
        // Still inside the competitor's transaction: provisioning has been
        // waiting on the fence, so nothing of it is visible to a reader.
        const [{ n }] = await admin<{ n: number }[]>`SELECT count(*)::int AS n FROM automation_tokens`;
        order.push(`competitor:saw ${n}`);
        order.push("competitor:commit");
      });
      await Bun.sleep(200);
      const provisioning = provisionServiceTokens({ ownerUrl: urlFor(name, OWNER), instance: "rm_it_fence", tokenFiles: paths.tokenFiles })
        .then(() => order.push("tokens:committed"));
      await competitor;
      await provisioning;
      expect(order).toEqual(["competitor:start", "competitor:saw 0", "competitor:commit", "tokens:committed"]);
      expect((await rowsOf(admin)).length).toBe(3);
    });
  }, 60_000);
});

describe("the direct-run form `bun smoke` starts", () => {
  async function runChild(database: string, root: string, instance: string, lock: { backendPid: number; holder: unknown }) {
    const url = new URL(config.databaseUrl);
    const resultFile = join(root, instance, "provision-result.json");
    const request = {
      instance,
      stateRoot: root,
      target: { host: url.hostname, port: Number(url.port), database, sslmode: "disable" },
      lock,
      resultFile,
    };
    const child = Bun.spawnSync(["bun", "--no-env-file", "scripts/provision-tokens.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? root, RM_PROVISION_REQUEST: JSON.stringify(request) },
      stdout: "pipe",
      stderr: "pipe",
    });
    const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null;
    return { exitCode: child.exitCode, stderr: child.stderr.toString(), result };
  }

  function writePasswords(root: string, instance: string) {
    const paths = instancePaths(root, instance, { create: true });
    writeFileSync(paths.rolePasswordsFile, JSON.stringify({ rm_owner: OWNER_PASSWORD, rm_app: "unused", rm_worker: "unused", rm_readonly: READER_PASSWORD }));
    chmodSync(paths.rolePasswordsFile, 0o600);
    return paths;
  }

  test("under the boot's held target lock it provisions all three holders and reports paths, never a secret", async () => {
    await withDatabase(async ({ name, admin }) => {
      const root = mkdtempSync(join(tmpdir(), "rm-tokens-run-"));
      roots.push(root);
      const instance = "rm_it_direct";
      const paths = writePasswords(root, instance);
      const reader = postgres(urlFor(name), { max: 1, onnotice: () => {} });
      const expected = await readTargetState(reader);
      await reader.end({ timeout: 5 });
      const acquired = await acquireTargetLock({
        databaseUrl: urlFor(name),
        holder: { tool: "smoke", planId: "c0ffee00c0ffee00c0ffee00", instance, host: "test-host", pid: process.pid },
        timeoutMs: 10_000,
        expected,
      });
      if (!acquired.acquired) throw new Error(acquired.reason);
      try {
        const run = await runChild(name, root, instance, { backendPid: acquired.lock.backendPid, holder: acquired.lock.holder });
        expect({ exitCode: run.exitCode, stderr: run.stderr }).toMatchObject({ exitCode: 0 });
        expect(run.result.ok).toBe(true);
        expect(run.result.holders).toEqual([...SERVICE_TOKEN_HOLDERS]);
        const text = JSON.stringify(run.result);
        for (const holder of SERVICE_TOKEN_HOLDERS) expect(text).not.toContain(secretOf(paths.tokenFiles[holder]));
        const rows = await rowsOf(admin);
        expect(rows.map((r) => [r.instance, r.holder, r.created_by])).toEqual(
          [...SERVICE_TOKEN_HOLDERS].sort().map((h) => [instance, h, "rm_owner"]),
        );
      } finally {
        await acquired.lock.release();
      }
    });
  }, 60_000);

  test("with the boot's lock released it refuses and writes no row", async () => {
    await withDatabase(async ({ name, admin }) => {
      const root = mkdtempSync(join(tmpdir(), "rm-tokens-run-"));
      roots.push(root);
      const instance = "rm_it_unlocked";
      const paths = writePasswords(root, instance);
      const reader = postgres(urlFor(name), { max: 1, onnotice: () => {} });
      const expected = await readTargetState(reader);
      await reader.end({ timeout: 5 });
      const acquired = await acquireTargetLock({
        databaseUrl: urlFor(name),
        holder: { tool: "smoke", planId: "c0ffee00c0ffee00c0ffee00", instance, host: "test-host", pid: process.pid },
        timeoutMs: 10_000,
        expected,
      });
      if (!acquired.acquired) throw new Error(acquired.reason);
      const held = { backendPid: acquired.lock.backendPid, holder: acquired.lock.holder };
      await acquired.lock.release();
      const run = await runChild(name, root, instance, held);
      expect(run.exitCode).toBe(1);
      expect(run.result).toMatchObject({ ok: false });
      expect(String(run.result.error)).toContain("cannot be proven held");
      expect((await rowsOf(admin)).length).toBe(0);
      for (const holder of SERVICE_TOKEN_HOLDERS) expect(existsSync(paths.tokenFiles[holder])).toBe(false);
    });
  }, 60_000);
});
