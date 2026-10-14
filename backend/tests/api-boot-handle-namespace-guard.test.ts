// The PRODUCTION boot path refuses a restored handle/id namespace violation
// (issue #602) — and, since issue #684, a database whose append-only guard has
// been disarmed. Both guards live on the same entrypoint, run against the same
// spawned process, and are graded here to the same standard, so the file covers
// the pair rather than only the one it is named after.
//
// WHAT MAKES THIS THE PRODUCTION PATH. docker-compose.yml's api service runs
// `command: ["bun", "run", "src/api/index.ts"]`, and that is the current
// bring-up command. So this file spawns THAT file, as a real process, as
// `rm_app`, against a real database, and grades the process: a violating
// database must produce a non-zero exit with both members named and NO port
// bound, and a clean database must boot and serve.
//
// WHAT CHANGED WITH ISSUE #973. The entrypoint used to serve past its startup
// preflight under `RM_ENV=ephemeral`, and this file used to grade "every other
// database shape must still boot and serve" through that exception. There is
// no exception any more: the §7.2 preflight (container-startup-preflight.test.ts)
// refuses an empty, unreachable, mid-migration or unmanifested database in
// every process. What these two guards owe such a database is unchanged and is
// still graded here: they CONCLUDE, within their budgets, loudly, and never
// hang or refuse wrongly — the guard's verdict is in the log before the
// preflight's refusal, and the process exits rather than spinning. The shapes
// that serve are graded through /health on a snapshot-bootstrapped database,
// the one a stack boots on.
//
// WHAT THIS FILE CANNOT PROVE. It spawns the entrypoint directly, so it grades
// the CODE's handling of RM_ALLOW_HANDLE_NAMESPACE_VIOLATION and
// PG_NAMESPACE_GUARD_TIMEOUT_MS and says nothing about whether either variable
// is DELIVERED to the deployed container — compose passes only what
// docker-compose.yml's api `environment:` allowlist names, and Bun.spawn
// bypasses that entirely. That half is asserted against real `docker compose
// config` output in scripts/tests/integration/smoke-compose-config.test.ts.
//
// The databases are throwaway copies of a snapshot-bootstrapped template on the
// suite's ephemeral Postgres (tests/preload.ts, which throws rather than skips
// when Docker is absent): the shared suite database can hold a forbidden pair
// no more than production can.
import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { checkAppendOnlyGuard } from "../src/db/append-only-guard.ts";
import {
  checkHandleNamespace,
  handleNamespaceConflicts,
  NAMESPACE_GUARD_BUDGET_MS,
  NAMESPACE_GUARD_DEFAULT_BUDGET_MS,
  NAMESPACE_GUARD_MAX_BUDGET_MS,
  parseGuardBudgetMs,
  type NamespaceDb,
} from "../src/db/handle-namespace.ts";
import { STARTUP_PREFLIGHT_DEFAULT_BUDGET_MS } from "../src/db/preflight.ts";
import { harnessConnection, ROLE_PASSWORD } from "./support/cluster.ts";
import {
  BACKEND_DIR,
  copyDatabase,
  createSnapshotTemplate,
  databaseUrl,
  dropDatabases,
  freePort,
  portIsBound,
} from "./support/startup-preflight.ts";

let template = "";
const created: string[] = [];

beforeAll(async () => {
  template = await createSnapshotTemplate("apiboot");
}, 120_000);

afterAll(async () => {
  await dropDatabases([...created, template].filter(Boolean));
});

/** A fresh copy of the snapshot template: schema, seed, ledger, manifest and identity, as a stack boots on. */
async function freshCopy(label: string): Promise<string> {
  const name = await copyDatabase(template, `apiboot_${label}`);
  created.push(name);
  return name;
}

/** The credential a stack hands the api. */
function appUrl(dbName: string): string {
  return databaseUrl(dbName, { name: "rm_app", password: ROLE_PASSWORD() });
}

/** An unreachable database: nothing listens on port 1. */
const UNREACHABLE = "postgres://rm_app:unused@127.0.0.1:1/unused";

interface Booted {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
}

function spawnApi(
  dbUrl: string,
  port: number,
  capture: boolean,
  extraEnv: Record<string, string> = {},
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["bun", "run", "src/api/index.ts"], {
    cwd: BACKEND_DIR,
    env: { ...process.env, DATABASE_URL: dbUrl, API_PORT: String(port), ...extraEnv },
    stdout: capture ? "pipe" : "ignore",
    stderr: "pipe",
  });
}

/** Boot the api and wait until /health answers — the proof it reached serving
 *  traffic. Fails loudly (never silently passes) if the process exits first. */
async function bootAndServe(
  dbUrl: string,
  extraEnv: Record<string, string> = {},
): Promise<Booted> {
  const port = await freePort();
  const proc = spawnApi(dbUrl, port, false, extraEnv);
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (proc.exitCode !== null) {
      const err = await new Response(proc.stderr as ReadableStream).text();
      throw new Error(`api exited with ${proc.exitCode} instead of serving:\n${err}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) {
        expect((await res.json()).status).toBe("ok");
        return { proc, port };
      }
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`api never served /health on :${port}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Boot the api against a database the §7.2 preflight refuses, and return what
 *  it logged before exiting. The guards' verdicts are in there, ahead of the
 *  preflight's refusal; the process exited and bound nothing. */
async function bootAndRefuse(
  dbUrl: string,
  extraEnv: Record<string, string> = {},
): Promise<{ stderr: string; stdout: string; elapsedMs: number }> {
  const port = await freePort();
  const startedAt = Date.now();
  const proc = spawnApi(dbUrl, port, true, extraEnv);
  const exitCode = await proc.exited;
  const elapsedMs = Date.now() - startedAt;
  const stderr = await new Response(proc.stderr as ReadableStream).text();
  const stdout = await new Response(proc.stdout as ReadableStream).text();
  expect(exitCode).toBe(1);
  expect(await portIsBound(port)).toBe(false);
  expect(stdout).not.toContain("api listening");
  expect(`${stdout}\n${stderr}`).toContain("startup_preflight: refused check");
  return { stderr, stdout, elapsedMs };
}

/** Place the forbidden pair the way a restore does: trigger off, two rows, trigger back ENABLE ALWAYS. */
async function restoreViolation(db: postgres.Sql<{}>, holder: string, shadowed: string): Promise<void> {
  // The restore shape, forced: 0031's trigger is ENABLE ALWAYS, so even
  // `session_replication_role = replica` cannot place the pair — a real
  // pg_restore gets in only because its COPY precedes CREATE TRIGGER. This is
  // a throwaway database, but the trigger is still restored with ENABLE ALWAYS
  // (never a plain ENABLE, which downgrades 'A' to 'O').
  await db`ALTER TABLE swarm_members DISABLE TRIGGER swarm_members_handle_namespace_trigger`;
  await db`INSERT INTO swarm_members (id, status, name, handle)
           VALUES (${shadowed}, 'active', 'Shadowed', ${`${shadowed}-h`})`;
  await db`INSERT INTO swarm_members (id, status, name, handle)
           VALUES (${holder}, 'active', 'Holder', ${shadowed})`;
  await db`ALTER TABLE swarm_members ENABLE ALWAYS TRIGGER swarm_members_handle_namespace_trigger`;
}

// ── AC1: the production boot path refuses a violating database ──────────────

test(
  "a database holding a restored violation: `bun run src/api/index.ts` exits non-zero, names both members, and binds no port",
  async () => {
    const dbName = await freshCopy("violating");
    const db = harnessConnection(dbName);
    const holder = "boot-holder";
    const shadowed = "boot-shadowed";
    try {
      await restoreViolation(db, holder, shadowed);

      const port = await freePort();
      const proc = spawnApi(appUrl(dbName), port, true);
      const exitCode = await proc.exited;
      const stderr = await new Response(proc.stderr as ReadableStream).text();

      expect(exitCode).not.toBe(0);
      // The operator's two questions: which rows, and is it serving.
      expect(stderr).toContain("REFUSING the boot");
      expect(stderr).toContain(holder);
      expect(stderr).toContain(shadowed);
      expect(stderr).toContain("addresses two members");
      expect(stderr).toContain("will NOT start");
      // The repair handed to the operator is a STATEMENT, and it names the
      // HOLDER — the member printed first. See the negative control below for
      // why naming either row would be wrong.
      expect(stderr).toContain(`WHERE id = '${holder}';`);
      expect(stderr).not.toContain(`WHERE id = '${shadowed}';`);
      // Refused BEFORE Bun.serve: nothing was ever bound, so no request was
      // ever answered from this database. And refused by THIS guard, ahead of
      // the preflight: the preflight never ran.
      expect(await portIsBound(port)).toBe(false);
      expect(stderr).not.toContain("startup_preflight:");

      // NEGATIVE control for that instruction. The runbook used to say the
      // repair was `UPDATE swarm_members SET handle = …` "on one of the two
      // rows". It is not: updating the SHADOWED member's handle succeeds
      // (UPDATE 1, no trigger refusal) and leaves the violation exactly where
      // it was. An operator who followed that would restart into the identical
      // refusal, mid-outage, having repointed a live URL for nothing.
      await db`UPDATE swarm_members SET handle = ${`${shadowed}-h2`} WHERE id = ${shadowed}`;
      expect(await handleNamespaceConflicts(db)).toHaveLength(1);

      // Positive control on the SAME database: moving the HOLDER's handle — the
      // statement the refusal printed — clears it, and the very same command
      // serves. Without this the test above is also satisfied by a guard that
      // refuses everything.
      await db`UPDATE swarm_members SET handle = ${`${holder}-h`} WHERE id = ${holder}`;
      expect(await handleNamespaceConflicts(db)).toHaveLength(0);
      const ok = await bootAndServe(appUrl(dbName));
      expect((await (await fetch(`http://127.0.0.1:${ok.port}/health`)).json()).handle_namespace).toBe("clean");
      ok.proc.kill();
      await ok.proc.exited;
    } finally {
      await db.end({ timeout: 5 });
    }
  },
  180_000,
);

// ── The shapes the guard must CONCLUDE on (a wrong or hanging guard is an outage) ─
//
// Each of these is refused by the §7.2 preflight, which runs after both guards
// (issue #973: no process serves past it). What is graded is that the guard
// reached its own verdict first, said so, never said REFUSING, and that the
// process exited instead of hanging in front of Bun.serve.

test(
  "an EMPTY database — no tables at all — is not a namespace violation: the guard concludes, and only the preflight refuses",
  async () => {
    const dbName = await freshCopy("empty");
    const admin = postgres(databaseUrl(dbName), { max: 1, onnotice: () => {} });
    try {
      await admin.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO rm_owner, rm_app");
    } finally {
      await admin.end({ timeout: 5 });
    }
    const { stderr } = await bootAndRefuse(appUrl(dbName));
    expect(stderr).not.toContain("REFUSING");
    expect(stderr).toContain("startup_preflight: refused check");
  },
  120_000,
);

test(
  "a database the api cannot reach AT ALL: the guard concludes loudly UNCHECKED, never REFUSING, and the preflight refuses check 1",
  async () => {
    // The honest limit of this guard, asserted rather than described: an
    // unreachable database is not a namespace violation. What the guard must
    // NOT do is stay silent about having skipped the check, or hang.
    const { stderr } = await bootAndRefuse(UNREACHABLE);
    expect(stderr).toContain("handle/id namespace guard could NOT run");
    expect(stderr).toContain("UNCHECKED");
    expect(stderr).not.toContain("REFUSING");
    expect(stderr).toContain("startup_preflight: refused check 1");
  },
  120_000,
);

test(
  "a MALFORMED PG_NAMESPACE_GUARD_TIMEOUT_MS ('8s') does not disable the bound: the guard still concludes, and says it ignored the value",
  async () => {
    // The knob that bounds the guard must not be the way to unbound it. With
    // `Number("8s")` → NaN, every deadline comparison in checkHandleNamespace is
    // a comparison against NaN — all false — so the retry loop never returns,
    // Bun.serve is never reached, no port is bound and NOTHING is logged. That
    // is the same total silent outage the guard exists to prevent, reached
    // through the guard's own configuration, and "8s" is exactly the shape an
    // operator writes. Measured against this database url on the unvalidated
    // version: no port bound after 30s and not one [api] line.
    //
    // "8s" over a random string on purpose: a duration suffix is the plausible
    // typo, not a nonsense word.
    const { stderr } = await bootAndRefuse(UNREACHABLE, { PG_NAMESPACE_GUARD_TIMEOUT_MS: "8s" });
    // Degrading to the default is only safe if it is LOUD: an operator who set
    // a budget and silently did not get it is worse off than one who is told.
    expect(stderr).toContain("PG_NAMESPACE_GUARD_TIMEOUT_MS");
    expect(stderr).toContain("IGNORING");
    expect(stderr).toContain(`${NAMESPACE_GUARD_DEFAULT_BUDGET_MS}ms`);
    // …and the check itself still reported its own outcome, so the fallback did
    // not quietly swallow the boot guard along with the bad value.
    expect(stderr).toContain("handle/id namespace guard could NOT run");
  },
  120_000,
);

test(
  "an OVER-CEILING PG_NAMESPACE_GUARD_TIMEOUT_MS ('3000000000') does not disable the bound either: the guard concludes on the default and says why",
  async () => {
    // The second way this knob can un-bound the guard, and the one that does NOT
    // look like a typo: 3000000000 IS a positive finite number of milliseconds,
    // so validation that only checks `Number.isFinite(x) && x > 0` accepts it —
    // and then setTimeout, which takes a 32-bit signed delay, clamps it to 1ms.
    // Every attempt expires instantly, the loop retries on its 1s backoff and
    // prints a TimeoutOverflowWarning stack each time, and the documented
    // "could NOT run" line is never reached. Measured on the real entrypoint
    // against an unreachable database before the ceiling existed: NO port bound
    // after 35s and not one [api] line — the identical never-binds, never-logs
    // outage as the "8s" case above.
    const { stderr, elapsedMs } = await bootAndRefuse(UNREACHABLE, { PG_NAMESPACE_GUARD_TIMEOUT_MS: "3000000000" });
    // Bounded by THE DEFAULT, not merely by this test's own deadline: the
    // rejected value must fall back to 8000ms, not to some other large budget.
    // The allowance is process spawn + bun startup + the preflight's own
    // (instant, connection-refused) check 1.
    expect(elapsedMs).toBeLessThan(NAMESPACE_GUARD_DEFAULT_BUDGET_MS + 7_000);
    expect(stderr).toContain("PG_NAMESPACE_GUARD_TIMEOUT_MS");
    expect(stderr).toContain("IGNORING");
    expect(stderr).toContain(`${NAMESPACE_GUARD_MAX_BUDGET_MS}ms a timer can hold`);
    expect(stderr).toContain(`${NAMESPACE_GUARD_DEFAULT_BUDGET_MS}ms`);
    expect(stderr).toContain("handle/id namespace guard could NOT run");
    // The specific symptom of the unbounded version, asserted absent rather than
    // inferred from the process having exited.
    expect(stderr).not.toContain("TimeoutOverflowWarning");
  },
  120_000,
);

test("parseGuardBudgetMs takes every budget a timer can hold and refuses the rest, loudly", () => {
  // The table the boot test cannot enumerate one process at a time.
  const lines: string[] = [];
  const parse = (raw: string | undefined) => parseGuardBudgetMs(raw, (l) => lines.push(l));

  // Honoured.
  expect(parse("15000")).toBe(15_000);
  expect(parse(" 15000 ")).toBe(15_000);
  expect(parse("2.5e4")).toBe(25_000);
  // Absent means default, and is NOT an operator error — no line.
  expect(parse(undefined)).toBe(NAMESPACE_GUARD_DEFAULT_BUDGET_MS);
  expect(parse("")).toBe(NAMESPACE_GUARD_DEFAULT_BUDGET_MS);
  expect(lines).toHaveLength(0);

  // The ceiling itself is a legitimate budget and stays silent — the rejection
  // below has to be about the values a timer genuinely cannot hold, not about
  // "large".
  expect(parse(String(NAMESPACE_GUARD_MAX_BUDGET_MS))).toBe(NAMESPACE_GUARD_MAX_BUDGET_MS);
  expect(lines).toHaveLength(0);

  // Refused — each falls back to the default rather than to NaN, and each says so.
  for (const bad of ["8s", "eight", "0", "-1", "NaN", "Infinity", "8 000"]) {
    expect(parse(bad)).toBe(NAMESPACE_GUARD_DEFAULT_BUDGET_MS);
  }
  // …including a value ABOVE what a timer can hold, which is not a long budget
  // but a 1ms one: setTimeout takes a 32-bit signed delay, and above it the
  // runtime clamps to 1ms, so every attempt would expire instantly and the loop
  // would retry once a second in front of Bun.serve — the same never-binds,
  // never-logs outage as the NaN case, reached through a value that IS a
  // positive finite number of milliseconds.
  for (const tooBig of ["2147483648", "3000000000", "1e300"]) {
    expect(parse(tooBig)).toBe(NAMESPACE_GUARD_DEFAULT_BUDGET_MS);
  }
  expect(lines).toHaveLength(10);
  for (const line of lines) {
    expect(line).toContain("[api]");
    expect(line).toContain("PG_NAMESPACE_GUARD_TIMEOUT_MS");
    expect(line).toContain("IGNORING");
    expect(line).toContain(`${NAMESPACE_GUARD_DEFAULT_BUDGET_MS}ms`);
  }
  // The rejected value is named, so the operator can find it in their env.
  expect(lines[0]).toContain('"8s"');
  // …and an over-ceiling value is rejected for its own stated reason, with the
  // ceiling quoted, rather than being called "not a positive number".
  expect(lines[7]).toContain('"2147483648"');
  expect(lines[7]).toContain(`larger than the maximum ${NAMESPACE_GUARD_MAX_BUDGET_MS}ms`);
  expect(lines[7]).not.toContain("is not a positive number");
});

test("checkHandleNamespace cannot spin on a non-positive or NaN budget", async () => {
  // The structural half of the fix: even if a budget of NaN reached this
  // function from somewhere parseGuardBudgetMs does not sit in front of, the
  // loop returns rather than retrying forever. `sql` is never touched, because
  // the first guard fires before any query — asserted by passing a client that
  // would throw if it were used.
  const explode = new Proxy(
    {},
    {
      get() {
        throw new Error("checkHandleNamespace queried the database on an expired budget");
      },
    },
  ) as unknown as NamespaceDb;
  for (const budget of [Number.NaN, 0, -5]) {
    const result = await checkHandleNamespace(explode, budget);
    expect(result.status).toBe("unavailable");
    expect(result.conflicts).toEqual([]);
    // WHICH guard answered, not merely that something did. There are two
    // negated-positive comparisons in that loop (the pre-attempt one and the
    // post-catch one), and asserting only "unavailable" is satisfied by either:
    // with the pre-attempt guard reverted, the Proxy above IS reached, its throw
    // is swallowed by the catch, and the post-catch guard returns an identically
    // shaped result — so the comment above ("sql is never touched") would be
    // false while the test stayed green. This detail can only come from the
    // pre-attempt guard, so each site is now independently protected.
    expect(result.detail).toContain("budget exhausted before the check could answer");
  }
});

// ── The guard must be BOUNDED, not merely retried (OPS-610-001) ─────────────

test(
  "a database whose swarm_members is held under ACCESS EXCLUSIVE: both guards conclude UNCHECKED within their budgets, and the process exits instead of hanging",
  async () => {
    // The failure this exists to prevent is the worst one this PR could cause.
    // A blocking database is NOT a rejecting database: the guard's readiness
    // probe reads only catalogs and returns immediately under an ACCESS
    // EXCLUSIVE lock, while the detection SELECT blocks — so a retry loop that
    // consults its deadline only after a rejection is bounded by nothing here.
    // `await assertHandleNamespaceClean()` would then never resolve, Bun.serve
    // would never be reached, no port would be bound and NOTHING would be
    // logged; `restart: unless-stopped` does not restart a process that hangs
    // instead of exiting. The lock below is an ordinary deploy-window event (a
    // migration replay, a REINDEX, a VACUUM FULL, an ALTER queued behind an
    // idle transaction). The §7.2 preflight that follows is bounded too
    // (STARTUP_PREFLIGHT_DEFAULT_BUDGET_MS) and refuses the blocked database,
    // so the whole boot is a bounded, logged exit — never a hang.
    const dbName = await freshCopy("locked");
    const locker = harnessConnection(dbName);
    let releaseLock!: () => void;
    const released = new Promise<void>((r) => (releaseLock = r));
    let lockHeld = false;
    let lockSettled = false;
    let lockTxn: Promise<unknown> | undefined;
    try {
      let lockTaken!: () => void;
      const taken = new Promise<void>((r) => (lockTaken = r));
      lockTxn = locker.begin(async (tx) => {
        await tx`LOCK TABLE swarm_members IN ACCESS EXCLUSIVE MODE`;
        lockHeld = true;
        lockTaken();
        await released; // held for the whole boot, released in `finally`
      });
      lockTxn.then(
        () => (lockSettled = true),
        () => (lockSettled = true),
      );
      await taken;

      const { stderr, stdout, elapsedMs } = await bootAndRefuse(appUrl(dbName));

      // The lock was taken AND was still held when the process exited — without
      // the second assertion this test would also pass on a lock that quietly
      // went away, which is the one way it could be green for the wrong reason.
      expect(lockHeld).toBe(true);
      expect(lockSettled).toBe(false);
      // Bounded — and bounded by THE BUDGETS, not by a round number that happens
      // to be larger. Asserting against the constants makes the assertion track
      // the claim. The allowance is process spawn + bun startup.
      expect(NAMESPACE_GUARD_BUDGET_MS).toBe(8_000); // the documented default
      expect(elapsedMs).toBeLessThan(NAMESPACE_GUARD_BUDGET_MS + STARTUP_PREFLIGHT_DEFAULT_BUDGET_MS + 7_000);

      // …and both guards' outcomes are in the log. The SECOND boot guard (issue
      // #684) sits behind this one against the same locked table, and it must
      // reach the same conclusion for the same reason. It nearly did not: its
      // probe is a `DELETE ... WHERE false`, which blocks on an ACCESS EXCLUSIVE
      // lock and comes back as `57014 canceling statement due to statement
      // timeout` — and a first version treated any error as evidence,
      // classified that as "the guard is gone" and REFUSED THE BOOT. Silence is
      // "unchecked", never "disarmed".
      expect(stderr).toContain("handle/id namespace guard could NOT run");
      expect(stderr).toContain("append-only guard check could NOT run");
      expect(stderr).toContain("UNCHECKED");
      expect(stderr).not.toContain("REFUSING");
      expect(`${stdout}\n${stderr}`).toContain("startup_preflight: refused check");
    } finally {
      releaseLock();
      await lockTxn?.catch(() => {});
      await locker.end({ timeout: 5 });
    }
  },
  180_000,
);

// ── The documented escape hatch (OPS-610-004) ───────────────────────────────

test(
  "RM_ALLOW_HANDLE_NAMESPACE_VIOLATION=1: the same violating database serves, loudly, and says so at /health",
  async () => {
    // A fail-closed gate on DATA — repairable only through an interactive SQL
    // session against production — needs a documented way out, or the guard
    // itself becomes the outage when it is the thing standing between an
    // operator and a running site. It must never be quiet about it.
    const dbName = await freshCopy("override");
    const db = harnessConnection(dbName);
    const holder = "ovr-holder";
    const shadowed = "ovr-shadowed";
    try {
      await restoreViolation(db, holder, shadowed);
    } finally {
      await db.end({ timeout: 5 });
    }

    const booted = await bootAndServe(appUrl(dbName), { RM_ALLOW_HANDLE_NAMESPACE_VIOLATION: "1" });
    // Machine-readable for the whole life of the process — an override left on
    // by accident must not look like a healthy boot.
    expect((await (await fetch(`http://127.0.0.1:${booted.port}/health`)).json()).handle_namespace).toBe("overridden");
    booted.proc.kill();
    await booted.proc.exited;
    const stderr = await new Response(booted.proc.stderr as ReadableStream).text();
    expect(stderr).toContain("OVERRIDE");
    expect(stderr).toContain("RM_ALLOW_HANDLE_NAMESPACE_VIOLATION");
    // The pair is still named: under an override this log is the only record
    // of what is being served wrong.
    expect(stderr).toContain(holder);
    expect(stderr).toContain(shadowed);
    // …and the guard did NOT also claim to be disarmed: on a violating
    // database the override is being USED, which is a different state from
    // the one the next test covers.
    expect(stderr).not.toContain("DISARMED");
  },
  180_000,
);

test(
  "an override left ON over a CLEAN database announces that the guard is DISARMED (OPS-610-007)",
  async () => {
    // The end of the documented procedure — set the override, restore service,
    // repair the rows, restart — leaves the variable set in the deploy
    // environment while the data is now clean. Without this line that state is
    // invisible: /health says `clean` (correctly — nothing is being served
    // wrong right now) and nothing anywhere says the guard will not stop the
    // NEXT bad restore. An operator must be able to tell a safe system from a
    // disarmed one.
    const dbName = await freshCopy("armedclean");
    const db = harnessConnection(dbName);
    try {
      await db`INSERT INTO swarm_members (id, status, name, handle)
               VALUES ('armed-a', 'active', 'A', 'armed-a-h')`;
    } finally {
      await db.end({ timeout: 5 });
    }

    const booted = await bootAndServe(appUrl(dbName), {
      RM_ALLOW_HANDLE_NAMESPACE_VIOLATION: "1",
    });
    const health = await fetch(`http://127.0.0.1:${booted.port}/health`);
    // The outcome stays honest: `overridden` means "a violation IS being
    // served", and this database holds none. The armed state is reported
    // separately, not by corrupting this field.
    expect((await health.json()).handle_namespace).toBe("clean");
    booted.proc.kill();
    await booted.proc.exited;
    const stderr = await new Response(booted.proc.stderr as ReadableStream).text();
    expect(stderr).toContain("RM_ALLOW_HANDLE_NAMESPACE_VIOLATION=1 is set");
    expect(stderr).toContain("DISARMED");
    // It is not an override event — no violation was found, and claiming one
    // would send an operator hunting for rows that do not exist.
    expect(stderr).not.toContain("OVERRIDE:");
    expect(stderr).not.toContain("REFUSING");
  },
  180_000,
);

test(
  "a CLEAN database with the override UNSET says nothing about it — the disarmed line is not boot noise",
  async () => {
    // The control for the case above: if that line printed on every boot it
    // would be ignored on the one boot it matters. Same database shape, one
    // variable different.
    const dbName = await freshCopy("unarmedclean");
    const db = harnessConnection(dbName);
    try {
      await db`INSERT INTO swarm_members (id, status, name, handle)
               VALUES ('unarmed-a', 'active', 'A', 'unarmed-a-h')`;
    } finally {
      await db.end({ timeout: 5 });
    }

    // Explicitly blank rather than merely absent: spawnApi inherits the
    // caller's environment, and a developer who exported the override in their
    // shell must not silently turn this control into a copy of the case above.
    const booted = await bootAndServe(appUrl(dbName), {
      RM_ALLOW_HANDLE_NAMESPACE_VIOLATION: "",
    });
    const health = await fetch(`http://127.0.0.1:${booted.port}/health`);
    expect((await health.json()).handle_namespace).toBe("clean");
    booted.proc.kill();
    await booted.proc.exited;
    const stderr = await new Response(booted.proc.stderr as ReadableStream).text();
    expect(stderr).not.toContain("DISARMED");
    expect(stderr).not.toContain("RM_ALLOW_HANDLE_NAMESPACE_VIOLATION");
  },
  180_000,
);

test(
  "a PRE-0030 database — swarm_members exists but has no `handle` column — is not a violation: the guard concludes, and only the preflight refuses",
  async () => {
    const dbName = await freshCopy("pre0030");
    const db = harnessConnection(dbName);
    try {
      // The exact intermediate the guard's to_regclass + column probe exists
      // for: the table is there, the column the predicate reads is not. This is
      // a database mid-way through its migrations, which is a migration's
      // business (and, since issue #973, the preflight's refusal) and not an
      // integrity violation.
      await db.unsafe("ALTER TABLE swarm_members DROP COLUMN handle CASCADE");
    } finally {
      await db.end({ timeout: 5 });
    }
    const { stderr } = await bootAndRefuse(appUrl(dbName));
    expect(stderr).not.toContain("REFUSING");
    expect(stderr).toContain("startup_preflight: refused check");
  },
  120_000,
);

// ── The SECOND boot guard: the append-only guard must be armed (issue #684) ──
//
// Same entrypoint, same production path, and it is graded the same way: a
// database that records migration 0032 as applied and no longer honours it must
// not be served, and a clean one must still boot.
//
// The disarmed database is built the way an owner would actually build it — one
// `CREATE OR REPLACE FUNCTION` — precisely because that is the state a trigger
// inventory cannot see. Every trigger still exists here, on every table, all
// reporting tgenabled='A'.

const DISARM_GUARD = `
CREATE OR REPLACE FUNCTION rm_append_only_guard() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN IF TG_LEVEL = 'ROW' THEN RETURN OLD; END IF; RETURN NULL; END $$;`;

test(
  "a database whose append-only guard function has been disarmed: the api exits non-zero and binds no port, and no override serves it",
  async () => {
    const dbName = await freshCopy("disarmed");
    const db = harnessConnection(dbName);
    try {
      // Control FIRST: the same database, untouched, boots and serves and says
      // so at /health. Without this, the refusal below is also satisfied by an
      // api that refuses every database.
      const armed = await bootAndServe(appUrl(dbName));
      const armedHealth = await (await fetch(`http://127.0.0.1:${armed.port}/health`)).json();
      expect(armedHealth.append_only_guard).toBe("armed");
      armed.proc.kill();
      await armed.proc.exited;

      await db.unsafe(DISARM_GUARD);
      // The catalog is untouched — this is the whole point of the fixture.
      const [{ n }] = (await db`
        SELECT count(*)::int AS n FROM pg_trigger
        WHERE NOT tgisinternal AND tgname LIKE '%\\_append\\_only%' AND tgenabled = 'A'
      `) as unknown as { n: number }[];
      expect(n, "every trigger is still installed and still ENABLE ALWAYS").toBeGreaterThan(0);

      // The OWNER sees the disarmed function for what it is: a DELETE is accepted.
      expect((await checkAppendOnlyGuard(db)).status).toBe("disarmed");

      // The api, as rm_app, cannot: every DELETE it probes is refused by the
      // executor at 42501 before any trigger runs (D55 (6)), which the guard
      // counts as protected (assertAppendOnlyGuardArmed, note 5). On a stack
      // the drifted function is caught by the §7.2 preflight instead — check 3
      // compares every function against the installed manifest — and that
      // refusal, unlike the guard's, has no override: the api exits non-zero,
      // binds no port, and names the function, with and without
      // RM_ALLOW_UNARMED_APPEND_ONLY_GUARD=1.
      for (const extraEnv of [{}, { RM_ALLOW_UNARMED_APPEND_ONLY_GUARD: "1" }] as Record<string, string>[]) {
        const { stderr, stdout } = await bootAndRefuse(appUrl(dbName), extraEnv);
        expect(`${stdout}\n${stderr}`).toContain("startup_preflight: refused check 3: function public.rm_append_only_guard() differs from the installed manifest");
        expect(stderr).not.toContain("OVERRIDE");
      }
    } finally {
      await db.end({ timeout: 5 });
    }
  },
  120_000,
);

test(
  "a database that predates migration 0032 is 'not applied', never 'disarmed': the guard says so, and only the preflight refuses",
  async () => {
    // The distinction that lets the guard above afford to fail closed: a
    // database that simply has not been migrated yet is not a disarmed one.
    // Since issue #973 the §7.2 preflight refuses such a database on its own
    // terms (its ledger is behind this image's), so what is graded here is the
    // guard's verdict — "not recorded", nothing wrong — and that it never
    // REFUSED the boot itself.
    const dbName = await freshCopy("pre0032");
    const db = harnessConnection(dbName);
    try {
      // Roll the ledger back to before 0032 and remove what it installed — the
      // shape of a database whose migrate() has not run yet.
      await db.unsafe(`ALTER TABLE schema_migrations DISABLE TRIGGER USER`);
      await db`DELETE FROM schema_migrations WHERE name = '0032_append_only_history.sql'`;
      await db.unsafe(`DROP FUNCTION rm_append_only_guard() CASCADE`);
    } finally {
      await db.end({ timeout: 5 });
    }
    const { stderr, stdout } = await bootAndRefuse(appUrl(dbName));
    expect(stdout).toContain("append-only guard: 0032_append_only_history.sql is not recorded in schema_migrations");
    expect(stderr).not.toContain("REFUSING");
    expect(stderr).not.toContain("DISARMED");
    expect(`${stdout}\n${stderr}`).toContain("startup_preflight: refused check");
  },
  120_000,
);
