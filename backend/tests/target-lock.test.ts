// Specification for backend/src/db/target-lock.ts — the target-lock protocol of
// docs/technical/smoke-production-spec.md §2, in full.
//
// TDD RED PHASE (issue #1026, W1 step 2). Every function under test currently
// throws `NOT IMPLEMENTED`; every test here fails today by design and is written
// against the behaviour the module must have once W1.7 lands.
//
// TIER. The key-derivation block below is pure and runs anywhere. Everything
// after it is an INTEGRATION-TIER gate that needs a live Postgres, and it gets
// one from this suite's own harness: tests/preload.ts provisions an ephemeral
// Postgres in Docker and publishes `DATABASE_URL` before any test file loads.
// Advisory locks are cluster-global and write no rows, so these tests take no
// clone of their own; instead each test derives a UNIQUE key from a random
// synthetic database identity, which is what keeps two tests in one file — and
// two files in one run — from contending with each other by accident.
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
//      lock." (integration tier)
//   - "Kill the lock connection mid-migration, start a second mutation tool: no
//      overlap." (integration tier — the `no overlap after the coordinating
//      connection dies` test below)
//   - "Standalone `bun run migrate` and `bun smoke` contend on the target lock,
//      including connection loss mid-phase." (integration tier)
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "../src/db/client.ts";
import type { DbHandle } from "../src/db/client.ts";
import {
  acquireTargetLock,
  assertStillHeld,
  describeHolder,
  revalidateAfterAcquire,
  targetLockKey,
  withMutationFence,
  type LockHolder,
  type TargetLock,
  type TargetLockKey,
} from "../src/db/target-lock.ts";

const DATABASE_URL = process.env.DATABASE_URL ?? "";

/** A key nothing else in the run can collide with. */
function uniqueKey(): TargetLockKey {
  return targetLockKey({ systemIdentifier: randomUUID(), databaseName: `robotmoney_${randomUUID().slice(0, 8)}` });
}

function holderOf(tool: string, instance: string | null): Omit<LockHolder, "acquiredAt"> {
  return { tool, instance, host: "test-host", pid: process.pid };
}

const opened: TargetLock[] = [];
async function acquire(key: TargetLockKey, tool: string, instance: string | null, timeoutMs = 500) {
  const result = await acquireTargetLock({ databaseUrl: DATABASE_URL, key, holder: holderOf(tool, instance), timeoutMs });
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

// ── Pure: key derivation ────────────────────────────────────────────────────

describe("targetLockKey — §2, keyed on the database identity, not the compose project", () => {
  const identity = { systemIdentifier: "7301234567890123456", databaseName: "robotmoney" };

  test("one database identity derives one key, every time and in every tool", () => {
    expect(targetLockKey(identity)).toBe(targetLockKey({ ...identity }));
  });

  test("two compose projects pointing at one database derive the SAME key, so they contend", () => {
    // The derivation takes no project, instance, role or connection string — the
    // absence of those inputs IS the property. Two callers with nothing in common
    // but the target must land in one namespace.
    expect(targetLockKey(identity)).toBe(targetLockKey({ ...identity }));
  });

  test("a different database on the same cluster derives a different key", () => {
    expect(targetLockKey({ ...identity, databaseName: "robotmoney_stage" })).not.toBe(targetLockKey(identity));
  });

  test("the same database name on a different cluster derives a different key", () => {
    expect(targetLockKey({ ...identity, systemIdentifier: "7309999999999999999" })).not.toBe(targetLockKey(identity));
  });

  test("an empty system identifier refuses: a partial derivation collides with every other partial one", () => {
    expect(() => targetLockKey({ systemIdentifier: "", databaseName: "robotmoney" })).toThrow(
      /system identifier|systemIdentifier/,
    );
  });

  test("an empty database name refuses for the same reason", () => {
    expect(() => targetLockKey({ systemIdentifier: "7301234567890123456", databaseName: "" })).toThrow(
      /database name|databaseName/,
    );
  });

  test("the key is a bigint, inside Postgres's 64-bit advisory namespace", () => {
    const key = targetLockKey(identity);
    expect(typeof key).toBe("bigint");
    expect(key >= -(2n ** 63n) && key < 2n ** 63n).toBe(true);
  });
});

// ── Integration tier: live Postgres from tests/preload.ts ───────────────────

describe("acquireTargetLock — §2, a session lock on its own dedicated connection [integration tier]", () => {
  test("acquisition takes a session-level advisory lock the server can confirm", async () => {
    const key = uniqueKey();
    const result = await acquire(key, "smoke", "alpha");
    expect(result.acquired).toBe(true);
    if (!result.acquired) return;

    expect(result.lock.key).toBe(key);
    expect(result.lock.holder.tool).toBe("smoke");
    expect(result.lock.holder.instance).toBe("alpha");
    expect(await result.lock.stillHeld()).toBe(true);

    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pg_locks
       WHERE locktype = 'advisory'
         AND ((classid::bigint << 32) | objid::bigint) = ${key.toString()}::bigint`;
    expect(Number(rows[0]?.count ?? "0")).toBeGreaterThan(0);
  });

  test("the lock lives on a connection of its own, not on the application pool", async () => {
    const key = uniqueKey();
    const result = await acquire(key, "smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");

    const [dedicated] = await result.lock.connection<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    const [pooled] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    expect(dedicated?.pid).not.toBe(pooled?.pid);
  });

  test("release is explicit and the server stops reporting the lock", async () => {
    const key = uniqueKey();
    const result = await acquire(key, "smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");

    await result.lock.release();
    expect(await result.lock.stillHeld()).toBe(false);
  });

  test("a second tool finds the lock held, waits its timeout, then refuses naming the holder", async () => {
    const key = uniqueKey();
    const first = await acquire(key, "smoke", "alpha");
    if (!first.acquired) throw new Error("expected acquisition");

    const second = await acquire(key, "migrate", null, 400);
    expect(second.acquired).toBe(false);
    if (second.acquired) throw new Error("expected a refusal");
    expect(second.waitedMs).toBeGreaterThanOrEqual(400);
    expect(second.holder?.tool).toBe("smoke");
    expect(second.holder?.instance).toBe("alpha");
    expect(second.reason).toContain("smoke");
    expect(second.reason).toContain("alpha");
  }, 15000);

  test("the wait is bounded — an unbounded wait is indistinguishable from a hang", async () => {
    const key = uniqueKey();
    const first = await acquire(key, "smoke", "alpha");
    if (!first.acquired) throw new Error("expected acquisition");

    const started = Date.now();
    await acquire(key, "migrate", null, 300);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15000);

  test("two instances preparing the same database serialize: the second acquires only after the first releases", async () => {
    const key = uniqueKey();
    const first = await acquire(key, "smoke", "alpha");
    if (!first.acquired) throw new Error("expected acquisition");

    expect((await acquire(key, "smoke", "beta", 300)).acquired).toBe(false);
    await first.lock.release();
    expect((await acquire(key, "smoke", "beta", 300)).acquired).toBe(true);
  }, 15000);

  test("a pooled handle is never accepted as the dedicated connection", async () => {
    const result = await acquire(uniqueKey(), "smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");
    const [dedicated] = await result.lock.connection<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    const [pooledAgain] = await sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    expect(dedicated?.pid).not.toBe(pooledAgain?.pid);
  });

  test("an unopenable connection refuses rather than reporting an acquisition", async () => {
    await expect(
      acquireTargetLock({
        databaseUrl: "postgres://nobody@127.0.0.1:1/nothing",
        key: uniqueKey(),
        holder: holderOf("migrate", null),
        timeoutMs: 300,
      }),
    ).rejects.toThrow();
  }, 15000);
});

describe("describeHolder — §2, a contention refusal must be able to name the holder [integration tier]", () => {
  test("reports the tool, instance, host and pid published at acquisition", async () => {
    const key = uniqueKey();
    const first = await acquire(key, "schedules:enable", "rm_prod");
    if (!first.acquired) throw new Error("expected acquisition");

    const holder = await describeHolder(sql, key);
    expect(holder?.tool).toBe("schedules:enable");
    expect(holder?.instance).toBe("rm_prod");
    expect(holder?.host).toBe("test-host");
    expect(holder?.pid).toBe(process.pid);
  });

  test("a free key reports null", async () => {
    expect(await describeHolder(sql, uniqueKey())).toBeNull();
  });
});

describe("revalidateAfterAcquire — §2, the plan is re-checked against the locked target [integration tier]", () => {
  test("a deployment_identity that does not match the plan refuses, naming it", async () => {
    const result = await acquire(uniqueKey(), "smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");

    const verdict = await revalidateAfterAcquire(result.lock, {
      identity: "production",
      ledgerHead: null,
      manifestHash: null,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason).toContain("deployment_identity");
  });

  test("a ledger head that moved while the tool waited refuses, naming the ledger", async () => {
    const result = await acquire(uniqueKey(), "smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");

    const verdict = await revalidateAfterAcquire(result.lock, {
      identity: "rehearsal",
      ledgerHead: "0001_no_such_migration.sql",
      manifestHash: null,
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason.toLowerCase()).toContain("ledger");
  });

  test("a manifest hash that does not match refuses, naming the manifest", async () => {
    const result = await acquire(uniqueKey(), "smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");

    const verdict = await revalidateAfterAcquire(result.lock, {
      identity: "rehearsal",
      ledgerHead: null,
      manifestHash: "manifest-that-is-not-installed",
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("expected a refusal");
    expect(verdict.reason.toLowerCase()).toContain("manifest");
  });

  test("the three re-reads the target actually reports are accepted", async () => {
    // Reads the target's OWN current answers and feeds them back as the plan's
    // expectations: revalidation's contract is "nothing moved while I waited",
    // so a plan built from the present must pass.
    const result = await acquire(uniqueKey(), "smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");

    const [identityRow] = await sql<{ kind: "production" | "rehearsal" }[]>`
      SELECT kind FROM deployment_identity LIMIT 1`;
    // The ledger column is `name`, NOT `filename`. This test named a column
    // that has never existed (`backend/src/db/migrate.ts:36` creates the table,
    // and `:47` reads `SELECT name FROM schema_migrations`), so it threw before
    // reaching `revalidateAfterAcquire` and no implementation could pass it.
    // The value is still the migration's full filename — which is the point,
    // since spec §8.1 makes the filename list, never the number, the identity.
    const [ledgerRow] = await sql<{ name: string }[]>`
      SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`;
    const [manifestRow] = await sql<{ content_hash: string }[]>`
      SELECT content_hash FROM schema_manifest LIMIT 1`;

    const verdict = await revalidateAfterAcquire(result.lock, {
      identity: identityRow?.kind ?? "rehearsal",
      ledgerHead: ledgerRow?.name ?? null,
      manifestHash: manifestRow?.content_hash ?? null,
    });
    expect(verdict.ok).toBe(true);
  });
});

describe("withMutationFence — §2, the fence is taken on the MUTATING connection [integration tier]", () => {
  test("the body runs inside a transaction that already holds the xact lock on the key", async () => {
    const key = uniqueKey();
    const observed = await withMutationFence({ databaseUrl: DATABASE_URL, key, label: "migrate" }, async (tx) => {
      const [self] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      const held = await tx<{ count: string }[]>`
        SELECT count(*)::text AS count FROM pg_locks
         WHERE locktype = 'advisory'
           AND pid = pg_backend_pid()
           AND ((classid::bigint << 32) | objid::bigint) = ${key.toString()}::bigint`;
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
    const key = uniqueKey();
    const lock = await acquire(key, "smoke", "alpha");
    if (!lock.acquired) throw new Error("expected acquisition");
    const [coordinator] = await lock.lock.connection<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;

    const mutatingPid = await withMutationFence({ databaseUrl: DATABASE_URL, key, label: "migrate" }, async (tx) => {
      const [self] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      return self?.pid ?? 0;
    });

    expect(mutatingPid).not.toBe(coordinator?.pid);
  });

  test("the transaction's commit is the release: the fence is gone once the body returns", async () => {
    const key = uniqueKey();
    await withMutationFence({ databaseUrl: DATABASE_URL, key, label: "migrate" }, async () => undefined);

    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pg_locks
       WHERE locktype = 'advisory'
         AND ((classid::bigint << 32) | objid::bigint) = ${key.toString()}::bigint`;
    expect(Number(rows[0]?.count ?? "0")).toBe(0);
  });

  test("a body that throws aborts the transaction, and the fence is released by the abort", async () => {
    const key = uniqueKey();
    await expect(
      withMutationFence({ databaseUrl: DATABASE_URL, key, label: "migrate" }, async () => {
        throw new Error("migration step failed");
      }),
    ).rejects.toThrow("migration step failed");

    const rows = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM pg_locks
       WHERE locktype = 'advisory'
         AND ((classid::bigint << 32) | objid::bigint) = ${key.toString()}::bigint`;
    expect(Number(rows[0]?.count ?? "0")).toBe(0);
  });

  test("a body that commits internally refuses: work that escapes the transaction is unfenced work", async () => {
    const key = uniqueKey();
    await expect(
      withMutationFence({ databaseUrl: DATABASE_URL, key, label: "migrate" }, async (tx: DbHandle) => {
        await tx.unsafe("COMMIT");
      }),
    ).rejects.toThrow(/fence|transaction|commit/i);
  });

  test("two fenced mutations on one key never overlap", async () => {
    const key = uniqueKey();
    const order: string[] = [];
    const slow = withMutationFence({ databaseUrl: DATABASE_URL, key, label: "a" }, async (tx) => {
      order.push("a:start");
      await tx`SELECT pg_sleep(0.4)`;
      order.push("a:end");
    });
    await Bun.sleep(80);
    const fast = withMutationFence({ databaseUrl: DATABASE_URL, key, label: "b" }, async () => {
      order.push("b:start");
      order.push("b:end");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  }, 15000);

  test("a waiter never cancels the holder — a cancellation request is not evidence the mutation stopped", async () => {
    const key = uniqueKey();
    const order: string[] = [];
    const holder = withMutationFence({ databaseUrl: DATABASE_URL, key, label: "holder" }, async (tx) => {
      await tx`SELECT pg_sleep(1.0)`;
      order.push("holder:committed");
      return "holder finished";
    });
    await Bun.sleep(100);

    const waiter = withMutationFence({ databaseUrl: DATABASE_URL, key, label: "waiter" }, async () => {
      order.push("waiter:entered");
      return "waiter finished";
    });

    expect(await holder).toBe("holder finished");
    expect(await waiter).toBe("waiter finished");
    expect(order).toEqual(["holder:committed", "waiter:entered"]);
  }, 20000);
});

describe("assertStillHeld — §2, no phase proceeds on a lock the tool cannot prove it holds [integration tier]", () => {
  test("a held lock passes the phase-boundary proof", async () => {
    const result = await acquire(uniqueKey(), "smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");
    await expect(assertStillHeld(result.lock, "preflight")).resolves.toBeUndefined();
  });

  test("a released lock fails the proof, naming the phase that was about to start", async () => {
    const result = await acquire(uniqueKey(), "smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");
    await result.lock.release();
    await expect(assertStillHeld(result.lock, "replace")).rejects.toThrow(/replace/);
  });

  test("a coordinating connection killed underneath the tool fails the proof — the flag is never consulted", async () => {
    const result = await acquire(uniqueKey(), "smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");

    const [self] = await result.lock.connection<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await sql`SELECT pg_terminate_backend(${self?.pid ?? 0})`;

    await expect(assertStillHeld(result.lock, "participants")).rejects.toThrow(/participants/);
  }, 15000);

  test("the proof never re-acquires and continues: the lock stays lost", async () => {
    const result = await acquire(uniqueKey(), "smoke", "alpha");
    if (!result.acquired) throw new Error("expected acquisition");
    await result.lock.release();

    await expect(assertStillHeld(result.lock, "readiness")).rejects.toThrow();
    expect(await result.lock.stillHeld()).toBe(false);
  });
});

describe("the §10 W1 gate: kill the lock connection mid-mutation, start a second tool, no overlap [integration tier]", () => {
  test("a competitor that wins the session lock after the coordinator died still blocks on the in-flight mutation", async () => {
    const key = uniqueKey();
    const order: string[] = [];

    // Tool A: coordinating session lock on its dedicated connection, plus a
    // long-running fenced mutation on a SEPARATE connection.
    const toolA = await acquire(key, "migrate", "alpha");
    if (!toolA.acquired) throw new Error("expected acquisition");
    const [coordinator] = await toolA.lock.connection<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;

    const aMutation = withMutationFence({ databaseUrl: DATABASE_URL, key, label: "migrate" }, async (tx) => {
      order.push("a:mutation-start");
      await tx`SELECT pg_sleep(1.2)`;
      order.push("a:mutation-end");
    });

    // The coordinating connection dies mid-mutation. Postgres releases the
    // SESSION lock immediately; the mutation is still executing.
    await Bun.sleep(150);
    await sql`SELECT pg_terminate_backend(${coordinator?.pid ?? 0})`;

    // Tool B now wins the session lock — and must still block on the fence.
    const toolB = await acquireTargetLock({
      databaseUrl: DATABASE_URL,
      key,
      holder: holderOf("smoke", "beta"),
      timeoutMs: 3000,
    });
    expect(toolB.acquired).toBe(true);
    if (!toolB.acquired) return;
    opened.push(toolB.lock);

    await withMutationFence({ databaseUrl: DATABASE_URL, key, label: "seed" }, async () => {
      order.push("b:mutation-start");
    });
    await aMutation;

    expect(order).toEqual(["a:mutation-start", "a:mutation-end", "b:mutation-start"]);
  }, 30000);
});
