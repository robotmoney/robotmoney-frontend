// Specification for backend/src/db/target-lock.ts — the target-lock protocol of
// docs/technical/smoke-production-spec.md §2, in full, as amended by D52.
//
// TIER. The pure blocks (the constant key, the pooler refusals, the session
// probe) run anywhere. Everything else is an INTEGRATION-TIER gate that needs a
// live Postgres, and it gets one from this suite's own harness:
// tests/preload.ts provisions an ephemeral Postgres in Docker and publishes
// `DATABASE_URL` before any test file loads.
//
// ONE KEY, SO ONE LOCK AT A TIME. The key is a constant (D52), so every test
// here contends on the same lock, exactly as every tool does. Bun runs a file's
// tests one after another and `afterEach` releases whatever a test left held,
// so no test inherits another's lock. Revalidation scenarios that must CHANGE
// the ledger or the manifest run in a scratch database of their own: the ledger
// of the shared test database is append-only and cannot be put back, and a
// scratch database is also the direct proof that Postgres scopes an advisory
// lock to one database.
//
// WHY THE ASSERTIONS GO THROUGH `pg_locks`. §2 says the session lock lives on a
// dedicated connection and the fence lives on the MUTATING connection, and a
// test that only observed "the second tool waited" cannot tell a correct
// implementation from one that took both locks on the coordinating connection —
// which passes every happy-path test and fails the only scenario that matters.
// So the tests below read the catalog and assert WHICH BACKEND holds what.
//
// Acceptance gates served (spec §10, W1):
//   - "Two instances preparing the same remote database serialize on the target
//      lock." (integration tier, including two hostnames for one database)
//   - "Kill the lock connection mid-migration, start a second mutation tool: no
//      overlap." (integration tier — both the commit and the abort ending)
//   - "Standalone `bun run migrate` and `bun smoke` contend on the target lock,
//      including connection loss mid-phase." (module half: contention names the
//      holder and its plan id, and real holder processes release on exit and on
//      SIGINT/SIGTERM; two real tools contending is the integration test that
//      later #1026 work adds)
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { sql } from "../src/db/client.ts";
import type { DbHandle } from "../src/db/client.ts";
import {
  acquireTargetLock,
  assertStillHeld,
  describeHolder,
  judgeSessionProbe,
  KNOWN_POOLER_PORTS,
  PLAN_ID_SHOWN,
  readTargetState,
  refusePoolerUrl,
  releaseTargetLockOnExit,
  revalidateAfterAcquire,
  TARGET_LOCK_KEY,
  withMutationFence,
  type LockHolder,
  type TargetLock,
  type TargetState,
} from "../src/db/target-lock.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const MODULE = join(import.meta.dir, "..", "src", "db", "target-lock.ts");
const PLAN_A = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2";

function holderOf(tool: string, instance: string | null, planId: string | null = null): Omit<LockHolder, "acquiredAt"> {
  return { tool, planId, instance, host: "test-host", pid: process.pid };
}

/** The shared test database's own answers, so a plain acquisition revalidates. */
async function present(): Promise<TargetState> {
  return readTargetState(sql);
}

const opened: TargetLock[] = [];
async function acquire(
  tool: string,
  instance: string | null,
  timeoutMs = 500,
  over: { databaseUrl?: string; expected?: TargetState; planId?: string | null } = {},
) {
  const result = await acquireTargetLock({
    databaseUrl: over.databaseUrl ?? DATABASE_URL,
    holder: holderOf(tool, instance, over.planId ?? null),
    timeoutMs,
    expected: over.expected ?? (await present()),
  });
  if (result.acquired) opened.push(result.lock);
  return result;
}

afterEach(async () => {
  while (opened.length > 0) {
    const lock = opened.pop();
    try {
      await lock?.release();
    } catch {
      /* the test may already have released or killed it */
    }
  }
});

/** The shared test database under its other spelling: `localhost` ⇄ `127.0.0.1`. */
function otherSpelling(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname === "localhost" ? "127.0.0.1" : "localhost";
  return parsed.toString();
}

/**
 * A throwaway database on the test cluster holding just the three tables
 * revalidation reads, seeded with a ledger of `ledger` and no manifest.
 */
async function withScratchDatabase<T>(
  ledger: readonly string[],
  body: (scratch: { url: string; conn: DbHandle }) => Promise<T>,
  enrollment: "kind" | "legacy-identity-column" | "no-table" = "kind",
): Promise<T> {
  const name = `rm_tl_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await sql.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(DATABASE_URL);
  url.pathname = `/${name}`;
  const conn = postgres(url.toString(), { max: 1, onnotice: () => {} });
  try {
    await conn`CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`;
    await conn`CREATE TABLE schema_manifest (content_hash text NOT NULL)`;
    if (enrollment === "kind") {
      await conn`CREATE TABLE deployment_identity (kind text NOT NULL)`;
      await conn`INSERT INTO deployment_identity (kind) VALUES ('rehearsal')`;
    } else if (enrollment === "legacy-identity-column") {
      await conn`CREATE TABLE deployment_identity (identity text NOT NULL)`;
      await conn`INSERT INTO deployment_identity (identity) VALUES ('production')`;
    }
    for (const file of ledger) await conn`INSERT INTO schema_migrations (name) VALUES (${file})`;
    return await body({ url: url.toString(), conn });
  } finally {
    // Release this file's locks on the scratch database before dropping it.
    while (opened.length > 0) await opened.pop()?.release();
    await conn.end({ timeout: 5 });
    await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
}

// ── Pure: one constant key ──────────────────────────────────────────────────

describe("TARGET_LOCK_KEY — §2 as amended by D52, one constant key", () => {
  test("the key is one constant bigint, non-negative, inside Postgres's 64-bit advisory namespace", () => {
    expect(typeof TARGET_LOCK_KEY).toBe("bigint");
    expect(TARGET_LOCK_KEY >= 0n && TARGET_LOCK_KEY < 2n ** 63n).toBe(true);
  });

  test("the module derives nothing: no export takes identity, database name or key from its caller", async () => {
    const exported = await import("../src/db/target-lock.ts");
    // The derivation this constant replaced was `targetLockKey(identity)`.
    expect("targetLockKey" in exported).toBe(false);
    // acquireTargetLock / withMutationFence / describeHolder take no key: the
    // lock actually taken is the constant, read back from the catalog below.
    const result = await acquire("smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");
    expect(result.lock.key).toBe(TARGET_LOCK_KEY);
    const [row] = await sql<{ key: string }[]>`
      SELECT ((classid::bigint << 32) | objid::bigint)::text AS key FROM pg_locks
       WHERE locktype = 'advisory' AND granted AND objsubid = 2
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`;
    expect(row?.key).toBe(TARGET_LOCK_KEY.toString());
  });
});

// ── Pure: never through a transaction-mode pooler ──────────────────────────

describe("the pooler refusal — §2, `the connection is direct, never through a transaction-mode pooler`", () => {
  test("a URL on the DigitalOcean pooler port refuses, naming the pooler and the direct port", () => {
    expect(() => refusePoolerUrl("postgres://rm_app:x@db.example.invalid:25061/robotmoney")).toThrow(/pooler.*25060/i);
  });

  test("every known pooler port refuses", () => {
    for (const port of KNOWN_POOLER_PORTS.keys()) {
      expect(() => refusePoolerUrl(`postgres://u:p@db.example.invalid:${port}/robotmoney`)).toThrow(/pooler/i);
    }
  });

  test("a URL marked pgbouncer=true refuses", () => {
    expect(() => refusePoolerUrl("postgres://u:p@db.example.invalid:5432/robotmoney?pgbouncer=true")).toThrow(
      /pgbouncer/i,
    );
  });

  test("a direct port passes", () => {
    expect(() => refusePoolerUrl("postgres://u:p@db.example.invalid:25060/robotmoney")).not.toThrow();
    expect(() => refusePoolerUrl("postgres://u:p@db.example.invalid/robotmoney")).not.toThrow();
  });

  test("acquisition refuses a pooler URL BEFORE opening a connection", async () => {
    // 192.0.2.1 is TEST-NET-1: a connect attempt there hangs rather than
    // failing, so a rejection inside a second proves no connection was tried.
    const started = Date.now();
    await expect(
      acquireTargetLock({
        databaseUrl: "postgres://rm_app:x@192.0.2.1:25061/robotmoney",
        holder: holderOf("smoke", "alpha"),
        timeoutMs: 300,
        expected: { identity: "rehearsal", ledger: [], manifestHash: null },
      }),
    ).rejects.toThrow(/pooler/i);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a mutation fence refuses the same URL", async () => {
    await expect(
      withMutationFence({ databaseUrl: "postgres://rm_app:x@192.0.2.1:25061/robotmoney", label: "seed" }, async () => 1),
    ).rejects.toThrow(/pooler/i);
  });

  test("the session probe: one backend that kept the setting is one session", () => {
    expect(judgeSessionProbe("n1", { pid: 10, probe: "n1" }, { pid: 10, probe: "n1" })).toBeNull();
  });

  test("the session probe: a second statement on another backend is a pooler, named with both pids", () => {
    const verdict = judgeSessionProbe("n1", { pid: 10, probe: "n1" }, { pid: 11, probe: null });
    expect(verdict).toMatch(/pooler/i);
    expect(verdict).toContain("10");
    expect(verdict).toContain("11");
  });

  test("the session probe: a lost session setting on the same pid is still refused", () => {
    expect(judgeSessionProbe("n1", { pid: 10, probe: "n1" }, { pid: 10, probe: null })).toMatch(/pooler/i);
  });
});

// ── Integration tier: live Postgres from tests/preload.ts ───────────────────

describe("acquireTargetLock — §2, a session lock on its own dedicated connection [integration tier]", () => {
  test("acquisition takes a session-level advisory lock the server can confirm", async () => {
    const result = await acquire("smoke", "alpha");
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;

    expect(result.lock.holder.tool).toBe("smoke");
    expect(result.lock.holder.instance).toBe("alpha");
    expect(await result.lock.stillHeld()).toBe(true);

    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pg_locks
       WHERE locktype = 'advisory'
         AND ((classid::bigint << 32) | objid::bigint) = ${TARGET_LOCK_KEY.toString()}::bigint`;
    expect(Number(rows[0]?.count ?? "0")).toBeGreaterThan(0);
  });

  test("the lock lives on a connection of its own, not on the application pool", async () => {
    const result = await acquire("smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");

    const [dedicated] = await result.lock.connection<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    const [pooled] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    expect(dedicated?.pid).not.toBe(pooled?.pid);
  });

  test("release is explicit and the server stops reporting the lock", async () => {
    const result = await acquire("smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");

    await result.lock.release();
    expect(await result.lock.stillHeld()).toBe(false);
  });

  test("a second tool finds the lock held, waits its timeout, then refuses naming the holder and its plan id", async () => {
    const first = await acquire("smoke", "alpha", 500, { planId: PLAN_A });
    if (!first.acquired) throw new Error("expected acquisition");

    const second = await acquire("migrate", null, 400);
    expect(second.acquired).toBe(false);
    if (second.acquired) throw new Error("expected a refusal");
    expect(second.refusal).toBe("contention");
    expect(second.waitedMs).toBeGreaterThanOrEqual(400);
    expect(second.holder?.tool).toBe("smoke");
    expect(second.holder?.instance).toBe("alpha");
    expect(second.holder?.planId).toBe(PLAN_A.slice(0, PLAN_ID_SHOWN));
    expect(second.holder?.pid).toBe(process.pid);
    expect(second.reason).toContain("smoke");
    expect(second.reason).toContain("alpha");
    expect(second.reason).toContain(`plan ${PLAN_A.slice(0, PLAN_ID_SHOWN)}`);
    expect(second.reason).toContain(String(process.pid));
  }, 15000);

  test("a holder with no plan is named as such, never as a blank", async () => {
    const first = await acquire("migrate", null, 500, { planId: null });
    if (!first.acquired) throw new Error("expected acquisition");
    const second = await acquire("smoke", "beta", 200);
    if (second.acquired) throw new Error("expected a refusal");
    expect(second.holder?.planId).toBeNull();
    expect(second.reason).toMatch(/no plan id/);
  }, 15000);

  test("the published holder fits the 63-byte application_name limit with a long instance and host", async () => {
    const result = await acquireTargetLock({
      databaseUrl: DATABASE_URL,
      holder: { tool: "spoof-keys", planId: PLAN_A, instance: "rm_local_0123456789abcdef", host: "rm-frontend-prod-1.example", pid: 4194304 },
      timeoutMs: 500,
      expected: await present(),
    });
    if (!result.acquired) throw new Error("expected acquisition");
    opened.push(result.lock);
    const holder = await describeHolder(sql);
    expect(holder?.tool).toBe("spoof-keys");
    expect(holder?.planId).toBe(PLAN_A.slice(0, PLAN_ID_SHOWN));
    expect(holder?.pid).toBe(4194304);
    expect(holder?.instance).toBe("rm_local_0123456789abcdef".slice(0, 24));
  });

  test("the wait is bounded — an unbounded wait is indistinguishable from a hang", async () => {
    const first = await acquire("smoke", "alpha");
    if (!first.acquired) throw new Error("expected acquisition");

    const started = Date.now();
    await acquire("migrate", null, 300);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15000);

  test("two instances preparing the same database serialize: the second acquires only after the first releases", async () => {
    const first = await acquire("smoke", "alpha");
    if (!first.acquired) throw new Error("expected acquisition");

    expect((await acquire("smoke", "beta", 300)).acquired).toBe(false);
    await first.lock.release();
    expect((await acquire("smoke", "beta", 300)).acquired).toBe(true);
  }, 15000);

  test("two hostnames for ONE database contend — the key is constant, and the server scopes it to the database", async () => {
    const viaOneName = await acquire("smoke", "alpha", 500, { databaseUrl: DATABASE_URL, planId: PLAN_A });
    if (!viaOneName.acquired) throw new Error("expected acquisition");

    const viaOtherName = await acquire("migrate", null, 300, { databaseUrl: otherSpelling(DATABASE_URL) });
    expect(viaOtherName.acquired).toBe(false);
    if (viaOtherName.acquired) throw new Error("expected a refusal");
    expect(viaOtherName.refusal).toBe("contention");
    expect(viaOtherName.reason).toContain(PLAN_A.slice(0, PLAN_ID_SHOWN));

    // And the other way round.
    await viaOneName.lock.release();
    const reversed = await acquire("migrate", null, 500, { databaseUrl: otherSpelling(DATABASE_URL) });
    if (!reversed.acquired) throw new Error("expected acquisition");
    expect((await acquire("smoke", "alpha", 300, { databaseUrl: DATABASE_URL })).acquired).toBe(false);
  }, 15000);

  test("two DIFFERENT databases on one cluster do not contend — the one constant key is per database", async () => {
    const onShared = await acquire("smoke", "alpha");
    if (!onShared.acquired) throw new Error("expected acquisition");
    await withScratchDatabase([], async ({ url }) => {
      const onScratch = await acquire("smoke", "beta", 300, {
        databaseUrl: url,
        expected: { identity: "rehearsal", ledger: [], manifestHash: null },
      });
      expect(onScratch.acquired).toBe(true);
    });
  }, 20000);

  test("a pooled handle is never accepted as the dedicated connection", async () => {
    const result = await acquire("smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");
    const [dedicated] = await result.lock.connection<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    const [pooledAgain] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    expect(dedicated?.pid).not.toBe(pooledAgain?.pid);
  });

  test("an unopenable connection refuses rather than reporting an acquisition", async () => {
    await expect(
      acquireTargetLock({
        databaseUrl: "postgres://nobody@127.0.0.1:1/nothing",
        holder: holderOf("migrate", null),
        timeoutMs: 300,
        expected: { identity: "rehearsal", ledger: [], manifestHash: null },
      }),
    ).rejects.toThrow();
  }, 15000);
});

describe("describeHolder — §2, a contention refusal must be able to name the holder [integration tier]", () => {
  test("reports the tool, plan id, instance, host and pid published at acquisition", async () => {
    const first = await acquire("spoof-keys", "rm_prod", 500, { planId: PLAN_A });
    if (!first.acquired) throw new Error("expected acquisition");

    const holder = await describeHolder(sql);
    expect(holder?.tool).toBe("spoof-keys");
    expect(holder?.planId).toBe(PLAN_A.slice(0, PLAN_ID_SHOWN));
    expect(holder?.instance).toBe("rm_prod");
    expect(holder?.host).toBe("test-host");
    expect(holder?.pid).toBe(process.pid);
  });

  test("a free lock reports null", async () => {
    expect(await describeHolder(sql)).toBeNull();
  });
});

describe("revalidateAfterAcquire — §2, the plan is re-checked against the locked target [integration tier]", () => {
  test("a deployment_identity that does not match the plan refuses, naming both values", async () => {
    const result = await acquire("smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");

    // The shared test database is migrated but never enrolled (the table has
    // no row), so it reads `missing` — never `rehearsal` (§4.3).
    const now = await present();
    expect(now.identity).toBe("missing");
    const verdict = await revalidateAfterAcquire(result.lock, { ...now, identity: "production" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toContain("deployment_identity is missing");
    expect(verdict.reason).toContain("built against production");
  });

  test("a ledger that differs from the plan's refuses, naming the ledger and both lists", async () => {
    const result = await acquire("smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");
    const now = await present();

    const verdict = await revalidateAfterAcquire(result.lock, {
      ...now,
      ledger: [...now.ledger, "9999_no_such_migration.sql"],
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toContain("ledger");
    expect(verdict.reason).toContain("9999_no_such_migration.sql");
    expect(verdict.reason).toContain(`${now.ledger.length} file(s)`);
  });

  test("a manifest hash that does not match refuses, naming both hashes", async () => {
    const result = await acquire("smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");

    const now = await present();
    const verdict = await revalidateAfterAcquire(result.lock, { ...now, manifestHash: "manifest-that-is-not-installed" });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toContain("manifest");
    expect(verdict.reason).toContain("manifest-that-is-not-installed");
    expect(verdict.reason).toContain(now.manifestHash ?? "absent");
  });

  test("the three re-reads the target actually reports are accepted", async () => {
    // Reads the target's OWN current answers and feeds them back as the plan's
    // expectations: revalidation's contract is "nothing moved while I waited",
    // so a plan built from the present must pass.
    const result = await acquire("smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");
    expect(await revalidateAfterAcquire(result.lock, await present())).toEqual({ ok: true });
  });

  test("acquireTargetLock itself revalidates: a stale plan is refused and the lock is released again", async () => {
    const stale = await acquire("smoke", "alpha", 500, { expected: { ...(await present()), identity: "production" } });
    expect(stale.acquired).toBe(false);
    if (stale.acquired) throw new Error("expected a refusal");
    expect(stale.refusal).toBe("revalidation");
    expect(stale.reason).toContain("deployment_identity");
    // Released: nobody holds it, so the next tool acquires at once.
    expect(await describeHolder(sql)).toBeNull();
    expect((await acquire("migrate", null, 200)).acquired).toBe(true);
  });

  test("a tool blocked behind a holder that MIGRATES while it waits refuses after acquiring — even below the head", async () => {
    await withScratchDatabase(["0001_first.sql", "0003_third.sql"], async ({ url, conn }) => {
      const planned = await readTargetState(conn);
      expect(planned.ledger).toEqual(["0001_first.sql", "0003_third.sql"]);

      const holder = await acquire("migrate", null, 500, { databaseUrl: url, expected: planned, planId: null });
      if (!holder.acquired) throw new Error("expected the holder to acquire");

      // Tool B queues behind the holder with the plan it built before waiting.
      const waiting = acquireTargetLockFor(url, planned);
      await Bun.sleep(200);
      // The holder migrates: a filename BELOW the head, so the head is unchanged
      // and only a whole-list comparison can see it.
      await withMutationFence({ databaseUrl: url, label: "migrate" }, async (tx) => {
        await tx`INSERT INTO schema_migrations (name) VALUES ('0002_second.sql')`;
      });
      await holder.lock.release();

      const result = await waiting;
      expect(result.acquired).toBe(false);
      if (result.acquired) throw new Error("expected a refusal");
      expect(result.refusal).toBe("revalidation");
      expect(result.reason).toContain("3 file(s) ending 0003_third.sql");
      expect(result.reason).toContain("2 file(s) ending 0003_third.sql");
      expect(result.reason).toContain("position 2: 0002_second.sql where the plan had 0003_third.sql");
      expect(await describeHolder(conn)).toBeNull();
    });
  }, 20000);

  test("a plan that saw NO manifest refuses when one appeared while it waited", async () => {
    await withScratchDatabase(["0001_first.sql"], async ({ url, conn }) => {
      const planned = await readTargetState(conn);
      expect(planned.manifestHash).toBeNull();

      const holder = await acquire("migrate", null, 500, { databaseUrl: url, expected: planned });
      if (!holder.acquired) throw new Error("expected the holder to acquire");
      const waiting = acquireTargetLockFor(url, planned);
      await Bun.sleep(200);
      await withMutationFence({ databaseUrl: url, label: "manifest" }, async (tx) => {
        await tx`INSERT INTO schema_manifest (content_hash) VALUES ('manifest-published-meanwhile')`;
      });
      await holder.lock.release();

      const result = await waiting;
      if (result.acquired) throw new Error("expected a refusal");
      expect(result.reason).toContain("manifest-published-meanwhile");
      expect(result.reason).toContain("no manifest");
    });
  }, 20000);

  test("a plan that saw an EMPTY ledger refuses when migrations appeared while it waited", async () => {
    await withScratchDatabase([], async ({ url, conn }) => {
      const planned = await readTargetState(conn);
      expect(planned.ledger).toEqual([]);
      await conn`INSERT INTO schema_migrations (name) VALUES ('0001_first.sql')`;

      const result = await acquire("smoke", "alpha", 500, { databaseUrl: url, expected: planned });
      if (result.acquired) throw new Error("expected a refusal");
      expect(result.reason).toContain("0 file(s)");
      expect(result.reason).toContain("0001_first.sql");
    });
  }, 20000);
});

describe("an unenrolled or legacy-enrolled target — §4.2/§4.3, absence is `missing`, never `rehearsal` [integration tier]", () => {
  test("a database with NO deployment_identity table reads as missing and still acquires", async () => {
    // A fresh `--local blank` database before bootstrap, a fresh cluster before
    // §9.1, or a pre-0063 production: the `bun run migrate` that creates the
    // table must be able to take the lock on it.
    await withScratchDatabase(
      ["0001_first.sql"],
      async ({ url, conn }) => {
        const planned = await readTargetState(conn);
        expect(planned.identity).toBe("missing");
        const result = await acquire("migrate", null, 500, { databaseUrl: url, expected: planned });
        expect(result.acquired).toBe(true);
      },
      "no-table",
    );
  }, 20000);

  test("an EMPTY deployment_identity table reads as missing, not rehearsal", async () => {
    await withScratchDatabase(["0001_first.sql"], async ({ conn }) => {
      await conn`DELETE FROM deployment_identity`;
      expect((await readTargetState(conn)).identity).toBe("missing");
    });
  }, 20000);

  test("a plan that saw NO table refuses when deployment_identity appeared while it waited", async () => {
    await withScratchDatabase(
      ["0001_first.sql"],
      async ({ url, conn }) => {
        const planned = await readTargetState(conn);
        expect(planned.identity).toBe("missing");

        const holder = await acquire("migrate", null, 500, { databaseUrl: url, expected: planned });
        if (!holder.acquired) throw new Error("expected the holder to acquire");
        const waiting = acquireTargetLockFor(url, planned);
        await Bun.sleep(200);
        await withMutationFence({ databaseUrl: url, label: "enroll" }, async (tx) => {
          await tx`CREATE TABLE deployment_identity (kind text NOT NULL)`;
          await tx`INSERT INTO deployment_identity (kind) VALUES ('production')`;
        });
        await holder.lock.release();

        const result = await waiting;
        expect(result.acquired).toBe(false);
        if (result.acquired) throw new Error("expected a refusal");
        expect(result.refusal).toBe("revalidation");
        expect(result.reason).toContain("deployment_identity is production");
        expect(result.reason).toContain("built against missing");
      },
      "no-table",
    );
  }, 20000);

  test("a database enrolled through the legacy `identity` column reads its value", async () => {
    await withScratchDatabase(
      ["0001_first.sql"],
      async ({ url, conn }) => {
        const planned = await readTargetState(conn);
        expect(planned.identity).toBe("production");
        expect((await acquire("migrate", null, 500, { databaseUrl: url, expected: planned })).acquired).toBe(true);
      },
      "legacy-identity-column",
    );
  }, 20000);

  test("more than one enrollment row is not an answer: readTargetState throws", async () => {
    await withScratchDatabase(["0001_first.sql"], async ({ conn }) => {
      await conn`INSERT INTO deployment_identity (kind) VALUES ('production')`;
      await expect(readTargetState(conn)).rejects.toThrow(/more than one row/);
    });
  }, 20000);
});

/** A second tool, queued on the scratch database with a plan built before it waited. */
async function acquireTargetLockFor(url: string, expected: TargetState) {
  const result = await acquireTargetLock({ databaseUrl: url, holder: holderOf("smoke", "beta", PLAN_A), timeoutMs: 5000, expected });
  if (result.acquired) opened.push(result.lock);
  return result;
}

describe("releaseTargetLockOnExit — §2, `released explicitly on exit` [integration tier, real processes]", () => {
  /**
   * Start a holder process that acquires the lock and reports `held`. It then
   * waits for the test to end it in one of three ways.
   */
  async function startHolder(mode: "signal" | "exit") {
    const dir = mkdtempSync(join(tmpdir(), "rm-target-lock-"));
    const script = join(dir, "holder.ts");
    writeFileSync(
      script,
      [
        `import { acquireTargetLock, releaseTargetLockOnExit } from ${JSON.stringify(MODULE)};`,
        `const result = await acquireTargetLock({`,
        `  databaseUrl: process.env.HOLDER_DATABASE_URL,`,
        `  holder: { tool: "migrate", planId: ${JSON.stringify(PLAN_A)}, instance: "holder", host: "child", pid: process.pid },`,
        `  timeoutMs: 5000,`,
        `  expected: JSON.parse(process.env.HOLDER_EXPECTED),`,
        `});`,
        `if (!result.acquired) { console.error(result.reason); process.exit(3); }`,
        mode === "signal" ? `releaseTargetLockOnExit(result.lock);` : `process.on("SIGUSR2", () => process.exit(0));`,
        `console.log("held");`,
        `setInterval(() => {}, 1000);`,
      ].join("\n"),
    );
    const child = Bun.spawn(["bun", script], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, HOLDER_DATABASE_URL: DATABASE_URL, HOLDER_EXPECTED: JSON.stringify(await present()) },
    });
    const decoder = new TextDecoder();
    let stdout = "";
    const reader = child.stdout.getReader();
    while (!stdout.includes("held")) {
      const { value, done } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
    }
    reader.releaseLock();
    if (!stdout.includes("held")) throw new Error(`holder never acquired: ${await new Response(child.stderr).text()}`);
    // Held right now, by the child, naming its plan.
    const blocked = await acquire("smoke", "alpha", 100);
    if (blocked.acquired) throw new Error("expected the child to hold the lock");
    expect(blocked.holder?.pid).toBe(child.pid);
    expect(blocked.reason).toContain(PLAN_A.slice(0, PLAN_ID_SHOWN));
    return child;
  }

  test("SIGTERM runs the release and exits 143 — the handler ran, the process was not merely killed", async () => {
    const child = await startHolder("signal");
    child.kill("SIGTERM");
    await child.exited;
    expect(child.exitCode).toBe(143);
    expect(child.signalCode).toBeNull();
    expect((await acquire("smoke", "alpha", 3000)).acquired).toBe(true);
  }, 30000);

  test("SIGINT runs the release and exits 130", async () => {
    const child = await startHolder("signal");
    child.kill("SIGINT");
    await child.exited;
    expect(child.exitCode).toBe(130);
    expect((await acquire("smoke", "alpha", 3000)).acquired).toBe(true);
  }, 30000);

  test("a lock freed by process exit becomes acquirable", async () => {
    const child = await startHolder("exit");
    child.kill("SIGUSR2");
    await child.exited;
    expect(child.exitCode).toBe(0);
    expect((await acquire("smoke", "alpha", 3000)).acquired).toBe(true);
  }, 30000);

  test("a SIGKILLed holder frees the lock too — the server drops the session with the socket", async () => {
    const child = await startHolder("exit");
    child.kill("SIGKILL");
    await child.exited;
    expect((await acquire("smoke", "alpha", 3000)).acquired).toBe(true);
  }, 30000);

  test("the disposer removes the handlers, so a finished tool does not keep them", async () => {
    const result = await acquire("smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");
    const before = process.listenerCount("SIGTERM");
    const dispose = releaseTargetLockOnExit(result.lock, { exit: () => undefined });
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    dispose();
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });
});

describe("withMutationFence — §2, the fence is taken on the MUTATING connection [integration tier]", () => {
  test("the body runs inside a transaction that already holds the xact lock on the key", async () => {
    const observed = await withMutationFence({ databaseUrl: DATABASE_URL, label: "migrate" }, async (tx) => {
      const [self] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const held = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM pg_locks
         WHERE locktype = 'advisory'
           AND pid = pg_backend_pid()
           AND ((classid::bigint << 32) | objid::bigint) = ${TARGET_LOCK_KEY.toString()}::bigint`;
      // Inside a transaction `now()` is the transaction's start, which is
      // strictly before a later statement's own timestamp; in autocommit the
      // two are equal. That difference is how this asserts BEGIN happened.
      await tx`SELECT pg_sleep(0.05)`;
      const inTransaction = await tx<{ open: boolean }[]>`
        SELECT now() < statement_timestamp() AS open`;
      return { pid: self?.pid ?? 0, held: Number(held[0]?.count ?? "0"), inTransaction: inTransaction[0]?.open === true };
    });

    expect(observed.held).toBeGreaterThan(0);
    expect(observed.inTransaction).toBe(true);
  });

  test("the fence is NOT taken on the coordinating connection — that one would die with it", async () => {
    const lock = await acquire("smoke", "alpha");
    if (!lock.acquired) throw new Error("expected acquisition");
    const [coordinator] = await lock.lock.connection<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;

    const mutatingPid = await withMutationFence({ databaseUrl: DATABASE_URL, label: "migrate" }, async (tx) => {
      const [self] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      return self?.pid ?? 0;
    });

    expect(mutatingPid).not.toBe(coordinator?.pid);
  });

  test("the transaction's commit is the release: the fence is gone once the body returns", async () => {
    await withMutationFence({ databaseUrl: DATABASE_URL, label: "migrate" }, async () => undefined);

    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pg_locks
       WHERE locktype = 'advisory'
         AND ((classid::bigint << 32) | objid::bigint) = ${TARGET_LOCK_KEY.toString()}::bigint`;
    expect(Number(rows[0]?.count ?? "0")).toBe(0);
  });

  test("a body that throws aborts the transaction, and the fence is released by the abort", async () => {
    await expect(
      withMutationFence({ databaseUrl: DATABASE_URL, label: "migrate" }, async () => {
        throw new Error("migration step failed");
      }),
    ).rejects.toThrow("migration step failed");

    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pg_locks
       WHERE locktype = 'advisory'
         AND ((classid::bigint << 32) | objid::bigint) = ${TARGET_LOCK_KEY.toString()}::bigint`;
    expect(Number(rows[0]?.count ?? "0")).toBe(0);
  });

  test("a body that commits internally refuses: work that escapes the transaction is unfenced work", async () => {
    await expect(
      withMutationFence({ databaseUrl: DATABASE_URL, label: "migrate" }, async (tx: DbHandle) => {
        await tx.unsafe("COMMIT");
      }),
    ).rejects.toThrow(/fence|transaction|commit/i);
  });

  test("two fenced mutations on one key never overlap", async () => {
    const order: string[] = [];
    const slow = withMutationFence({ databaseUrl: DATABASE_URL, label: "a" }, async (tx) => {
      order.push("a:start");
      await tx`SELECT pg_sleep(0.4)`;
      order.push("a:end");
    });
    await Bun.sleep(80);
    const fast = withMutationFence({ databaseUrl: DATABASE_URL, label: "b" }, async () => {
      order.push("b:start");
      order.push("b:end");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  }, 15000);

  test("a waiter never cancels the holder — a cancellation request is not evidence the mutation stopped", async () => {
    const order: string[] = [];
    const holder = withMutationFence({ databaseUrl: DATABASE_URL, label: "holder" }, async (tx) => {
      await tx`SELECT pg_sleep(1.0)`;
      order.push("holder:committed");
      return "holder finished";
    });
    await Bun.sleep(100);

    const waiter = withMutationFence({ databaseUrl: DATABASE_URL, label: "waiter" }, async () => {
      order.push("waiter:entered");
      return "waiter finished";
    });

    expect(await holder).toBe("holder finished");
    expect(await waiter).toBe("waiter finished");
    expect(order).toEqual(["holder:committed", "waiter:entered"]);
  }, 20000);
});

describe("the seed and the identity write are fenced mutations — a competitor's fence holds each until it commits (criterion 35)", () => {
  // Spec §2: "Every mutation (migration, grant reconciliation, seed, key rebind,
  // token provisioning, identity write) runs in a transaction that first takes
  // `pg_advisory_xact_lock` on the same key". `bun smoke` performs both of these
  // exactly as below (backend/scripts/smoke-prepare.ts): the identity write
  // through smoke-identity.ts's enrollAsRehearsal over the fence's own
  // transaction, the seed through seed.ts over the same kind of transaction.
  // A competitor holds the fence in the middle of a slow mutation; each must
  // start only after the competitor COMMITS.
  //
  // Each case writes into a database of its OWN, copied from the suite's
  // template and dropped after (never the file's shared database, and never a
  // DELETE to reset it). Advisory locks are per database, so the competitor
  // fences on the same copy.
  async function withTemplateCopy<T>(body: (url: string) => Promise<T>): Promise<T> {
    const template = process.env.RM_TEST_TEMPLATE_DB;
    if (!template) throw new Error("RM_TEST_TEMPLATE_DB is not set (tests/preload.ts sets it)");
    const name = `rm_tl_fence_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    await sql.unsafe(`CREATE DATABASE "${name}" TEMPLATE "${template}"`);
    const url = new URL(DATABASE_URL);
    url.pathname = `/${name}`;
    try {
      return await body(url.toString());
    } finally {
      await sql.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    }
  }

  async function competitor(url: string, order: string[]): Promise<void> {
    await withMutationFence({ databaseUrl: url, label: "competitor" }, async (tx) => {
      order.push("competitor:start");
      await tx`SELECT pg_sleep(0.6)`;
      order.push("competitor:commit");
    });
  }

  test("the identity write waits for the competitor's fence, then writes rehearsal inside its own", async () => {
    const { enrollAsRehearsal, transactionIdentityStore } = await import("../../scripts/lib/smoke-identity.ts");
    await withTemplateCopy(async (url) => {
      const reader = postgres(url, { max: 1, onnotice: () => {} });
      try {
        // The copy starts unenrolled, so the row read afterwards is this write's.
        expect(await reader<{ n: number }[]>`SELECT count(*)::int AS n FROM deployment_identity`).toMatchObject([{ n: 0 }]);
        const order: string[] = [];
        const held = competitor(url, order);
        await Bun.sleep(150);
        const write = withMutationFence({ databaseUrl: url, label: "identity" }, async (tx) => {
          order.push("identity:start");
          const row = await enrollAsRehearsal(transactionIdentityStore(tx), { note: "fence test", remoteAcknowledged: false });
          order.push("identity:wrote");
          return row;
        });
        await held;
        const row = await write;
        expect(order).toEqual(["competitor:start", "competitor:commit", "identity:start", "identity:wrote"]);
        expect(row.kind).toBe("rehearsal");
        const [stored] = await reader<{ kind: string }[]>`SELECT kind FROM deployment_identity`;
        expect(stored?.kind).toBe("rehearsal");
      } finally {
        await reader.end({ timeout: 5 });
      }
    });
  }, 30_000);

  test("the seed waits for the competitor's fence, then runs every statement inside its own", async () => {
    const { seed } = await import("../src/db/seed.ts");
    await withTemplateCopy(async (url) => {
      const order: string[] = [];
      const held = competitor(url, order);
      await Bun.sleep(150);
      const seeding = withMutationFence({ databaseUrl: url, label: "seed" }, async (tx) => {
        order.push("seed:start");
        await seed(tx);
        order.push("seed:done");
      });
      await held;
      await seeding;
      expect(order).toEqual(["competitor:start", "competitor:commit", "seed:start", "seed:done"]);
    });
  }, 30_000);
});

describe("assertStillHeld — §2, no phase proceeds on a lock the tool cannot prove it holds [integration tier]", () => {
  test("a held lock passes the phase-boundary proof", async () => {
    const result = await acquire("smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");
    await expect(assertStillHeld(result.lock, "preflight")).resolves.toBeUndefined();
  });

  test("a released lock fails the proof, naming the phase that was about to start", async () => {
    const result = await acquire("smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");
    await result.lock.release();
    await expect(assertStillHeld(result.lock, "replace")).rejects.toThrow(/replace/);
  });

  test("a coordinating connection killed underneath the tool fails the proof — the flag is never consulted", async () => {
    const result = await acquire("smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");

    const [self] = await result.lock.connection<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await sql`SELECT pg_terminate_backend(${self?.pid ?? 0})`;

    await expect(assertStillHeld(result.lock, "participants")).rejects.toThrow(/participants/);
  }, 15000);

  test("the proof never re-acquires and continues: the lock stays lost", async () => {
    const result = await acquire("smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");
    await result.lock.release();

    await expect(assertStillHeld(result.lock, "readiness")).rejects.toThrow();
    expect(await result.lock.stillHeld()).toBe(false);
  });
});

describe("the §10 W1 gate: kill the lock connection mid-mutation, start a second tool, no overlap [integration tier]", () => {
  /** Tool A: coordinating session lock, plus a fenced mutation on a SEPARATE connection. */
  async function coordinatorWithMutation(order: string[], ending: "commit" | "abort") {
    const toolA = await acquire("migrate", "alpha");
    if (!toolA.acquired) throw new Error("expected acquisition");
    const [coordinator] = await toolA.lock.connection<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;

    const aMutation = withMutationFence({ databaseUrl: DATABASE_URL, label: "migrate" }, async (tx) => {
      order.push("a:mutation-start");
      await tx`SELECT pg_sleep(1.2)`;
      if (ending === "abort") {
        order.push("a:mutation-abort");
        throw new Error("tool A's migration failed after its coordinator died");
      }
      order.push("a:mutation-end");
    });

    // The coordinating connection dies mid-mutation. Postgres releases the
    // SESSION lock immediately; the mutation is still executing.
    await Bun.sleep(150);
    await sql`SELECT pg_terminate_backend(${coordinator?.pid ?? 0})`;
    // Wrapped, so the caller receives the IN-FLIGHT promise: returning it bare
    // from an async function would make the caller wait for it to settle.
    return { aMutation };
  }

  async function competitorBlocksOnFence(order: string[]) {
    // Tool B now wins the session lock — and must still block on the fence.
    const toolB = await acquireTargetLock({
      databaseUrl: DATABASE_URL,
      holder: holderOf("smoke", "beta", PLAN_A),
      timeoutMs: 3000,
      expected: await present(),
    });
    expect(toolB.acquired).toBe(true);
    if (!toolB.acquired) return;
    opened.push(toolB.lock);

    await withMutationFence({ databaseUrl: DATABASE_URL, label: "seed" }, async () => {
      order.push("b:mutation-start");
    });
  }

  test("a competitor that wins the session lock after the coordinator died still blocks until the in-flight mutation COMMITS", async () => {
    const order: string[] = [];
    const { aMutation } = await coordinatorWithMutation(order, "commit");
    await competitorBlocksOnFence(order);
    await aMutation;
    expect(order).toEqual(["a:mutation-start", "a:mutation-end", "b:mutation-start"]);
  }, 30000);

  test("the same competitor blocks until the in-flight mutation ABORTS, and runs only after the abort", async () => {
    const order: string[] = [];
    const { aMutation } = await coordinatorWithMutation(order, "abort");
    // Observe A's rejection without letting it escape before B has run.
    const aSettled = aMutation.then(
      () => "committed",
      (err: Error) => err.message,
    );
    await competitorBlocksOnFence(order);
    expect(await aSettled).toContain("coordinator died");
    expect(order).toEqual(["a:mutation-start", "a:mutation-abort", "b:mutation-start"]);
  }, 30000);
});
