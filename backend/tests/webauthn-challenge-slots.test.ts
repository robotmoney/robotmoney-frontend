// WebAuthn challenges live in 32 fixed slots: unauthenticated option requests
// can never grow the table, and a challenge is consumed at most once — issue
// #1026 criterion 171, decision D55 (6), migration 0088.
//
// D55 (6): "A table that unauthenticated requests write stays bounded with no
// `rm_owner` run. WebAuthn challenges use a fixed set of 32 slots. A new
// challenge overwrites the oldest slot under `CHALLENGE_ISSUE_LOCK`, and a
// single-use conditional `UPDATE` consumes it. Gate: more than 32
// unauthenticated option requests leave the row count at 32."
//
// Asked of the RUNNING api (`bun run src/api/index.ts`), logged in as rm_app,
// on a snapshot-bootstrapped database — where rm_app holds SELECT and UPDATE on
// the table and neither INSERT nor DELETE, so a DELETE anywhere on the path
// would fail the request with 42501. "No DELETE issued" is therefore proved by
// every request succeeding, and the catalog read that the privilege is absent.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { provisionAutomationToken } from "../src/db/automation-tokens.ts";
import { restoreRoles, saveRoles, type SavedRole } from "./fixtures/releases/release-fixture.ts";
import {
  BACKEND_DIR,
  connectAdmin,
  createSnapshotTemplate,
  databaseUrl,
  dropDatabases,
  freePort,
} from "./support/startup-preflight.ts";
import { harnessConnection, restoreRoleBaselineAfterAll } from "./support/cluster.ts";

const APP = { name: "rm_app", password: `rm_app_slots_${randomBytes(6).toString("hex")}` };
const SLOTS = 32;
/** Slots 0..7 are registration's, 8..31 authentication's (migration 0088). */
const REGISTRATION_SLOTS = 8;

let name = "";
let fixture: postgres.Sql<{}>;
let savedRoles: SavedRole[] = [];
let api: { base: string; proc: ReturnType<typeof Bun.spawn> } | null = null;
/** The operator's store token (right `fixture`): it opens the registration flow. */
let operator = "";

async function call(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${api!.base}${path}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** A verify request carrying `challenge` and a credential id no passkey has:
 *  it consumes the challenge (or is refused for it) before the passkey lookup. */
const verifyWith = (challenge: string) =>
  call("POST", "/api/admin/webauthn/auth/verify", {
    id: "no-such-passkey",
    response: { clientDataJSON: Buffer.from(JSON.stringify({ challenge })).toString("base64url") },
  });

const rowCount = async (): Promise<number> =>
  ((await fixture`SELECT count(*)::int AS n FROM admin_webauthn_challenge`) as unknown as { n: number }[])[0]!.n;

beforeAll(async () => {
  // cluster admin: saving and altering a role is superuser-only
  const cluster = connectAdmin();
  try {
    savedRoles = await saveRoles(cluster);
    await cluster.unsafe(`ALTER ROLE rm_app LOGIN PASSWORD '${APP.password}'`);
  } finally {
    await cluster.end({ timeout: 5 });
  }
  name = await createSnapshotTemplate("webauthn_slots");
  fixture = harnessConnection(name);
  operator = (await provisionAutomationToken(`rm_slots_${process.pid}`, ["admin"], { holder: "operator", db: fixture })).token;

  const port = await freePort();
  const proc = Bun.spawn(["bun", "run", "src/api/index.ts"], {
    cwd: BACKEND_DIR,
    env: { ...process.env, RM_ENV: "stage", DATABASE_URL: databaseUrl(name, APP), API_PORT: String(port) },
    stdout: "ignore",
    stderr: "pipe",
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (proc.exitCode !== null) {
      throw new Error(`api exited with ${proc.exitCode}:\n${await new Response(proc.stderr as ReadableStream).text()}`);
    }
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`api never served /health on :${port}`);
    await Bun.sleep(100);
  }
  api = { base, proc };
}, 120_000);

afterAll(async () => {
  if (api) {
    api.proc.kill();
    await api.proc.exited;
  }
  await fixture?.end({ timeout: 5 });
  // cluster admin: restoring a role is superuser-only
  const cluster = connectAdmin();
  try {
    await restoreRoles(cluster, savedRoles);
  } finally {
    await cluster.end({ timeout: 5 });
  }
  await dropDatabases(name ? [name] : []);
});

describe("the api boots as rm_app on a blank bootstrap with both boot guards armed", () => {
  test("/health reports the append-only and analytics-ledger guards armed, not unchecked", async () => {
    // rm_app holds no DELETE on any table (D55 (6)), so each guard's
    // `DELETE ... WHERE false` probe gets 42501. That is the conclusive answer;
    // counted as inconclusive it would leave every boot "unchecked".
    const health = await call("GET", "/health");
    expect(health.status).toBe(200);
    expect({
      append_only_guard: health.body.append_only_guard,
      analytics_ledger_guard: health.body.analytics_ledger_guard,
    }).toEqual({ append_only_guard: "armed", analytics_ledger_guard: "armed" });
  });
});

describe("the challenge store is 32 slots by shape (D55 (6))", () => {
  test("a blank bootstrap holds exactly 32 empty slots, numbered 0..31", async () => {
    const rows = (await fixture`
      SELECT slot, challenge, flow, issued_at, expires_at, consumed_at FROM admin_webauthn_challenge ORDER BY slot`) as unknown as {
      slot: number;
      challenge: string | null;
    }[];
    expect(rows.map((r) => r.slot)).toEqual(Array.from({ length: SLOTS }, (_, i) => i));
    expect(rows.every((r) => r.challenge === null)).toBe(true);
  });

  test("the runtime cannot add or remove a slot: rm_app holds SELECT and UPDATE only, and a 33rd slot violates the key's CHECK", async () => {
    const [grants] = (await fixture`
      SELECT has_table_privilege('rm_app', 'public.admin_webauthn_challenge', 'SELECT') AS s,
             has_table_privilege('rm_app', 'public.admin_webauthn_challenge', 'UPDATE') AS u,
             has_table_privilege('rm_app', 'public.admin_webauthn_challenge', 'INSERT') AS i,
             has_table_privilege('rm_app', 'public.admin_webauthn_challenge', 'DELETE') AS d,
             has_table_privilege('rm_app', 'public.admin_webauthn_challenge', 'TRUNCATE') AS t`) as unknown as Record<string, boolean>[];
    expect(grants).toEqual({ s: true, u: true, i: false, d: false, t: false });
    let code: string | undefined;
    try {
      await fixture`INSERT INTO admin_webauthn_challenge (slot) VALUES (32)`;
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("23514");
  });

  test("more than 32 unauthenticated option requests — 40, concurrently — all succeed and leave exactly 32 rows", async () => {
    const responses = await Promise.all(Array.from({ length: 40 }, () => call("GET", "/api/admin/webauthn/auth/options")));
    expect(responses.map((r) => r.status)).toEqual(Array(40).fill(200));
    expect(await rowCount()).toBe(SLOTS);
    // Every authentication slot (8..31) now holds one of the issued challenges,
    // each once: the 24 issued last, whichever order the lock admitted them
    // in. The registration slots (0..7) were never touched.
    const held = (await fixture`
      SELECT slot, challenge, flow FROM admin_webauthn_challenge WHERE slot >= ${REGISTRATION_SLOTS}
       ORDER BY issued_at DESC, slot`) as unknown as { slot: number; challenge: string; flow: string }[];
    const issued = new Set(responses.map((r) => r.body.challenge as string));
    expect(held.length).toBe(SLOTS - REGISTRATION_SLOTS);
    expect(new Set(held.map((h) => h.challenge)).size).toBe(SLOTS - REGISTRATION_SLOTS);
    expect(held.every((h) => issued.has(h.challenge) && h.flow === "authentication")).toBe(true);
    const registration = (await fixture`
      SELECT count(*)::int AS n FROM admin_webauthn_challenge
       WHERE slot < ${REGISTRATION_SLOTS} AND challenge IS NOT NULL`) as unknown as { n: number }[];
    expect(registration[0]!.n).toBe(0);

    // And 40 more, sequentially: still 32.
    for (let i = 0; i < 40; i++) expect((await call("GET", "/api/admin/webauthn/auth/options")).status).toBe(200);
    expect(await rowCount()).toBe(SLOTS);
  }, 60_000);

  test("each issuance overwrites the authentication slot issued longest ago", async () => {
    const [oldest] = (await fixture`
      SELECT slot FROM admin_webauthn_challenge WHERE slot >= ${REGISTRATION_SLOTS}
       ORDER BY issued_at ASC NULLS FIRST, slot LIMIT 1`) as unknown as {
      slot: number;
    }[];
    const issued = await call("GET", "/api/admin/webauthn/auth/options");
    const [written] = (await fixture`
      SELECT slot FROM admin_webauthn_challenge WHERE challenge = ${issued.body.challenge as string}`) as unknown as {
      slot: number;
    }[];
    expect(written!.slot).toBe(oldest!.slot);
  });
});

describe("a challenge is consumed once, and an expired or consumed one is never accepted", () => {
  test("two racing consumers of one challenge: exactly one gets past the challenge", async () => {
    const issued = await call("GET", "/api/admin/webauthn/auth/options");
    const challenge = issued.body.challenge as string;
    const results = await Promise.all([verifyWith(challenge), verifyWith(challenge)]);
    // The winner consumed it and was then refused for its (absent) passkey;
    // the loser was refused for the challenge itself.
    expect(results.map((r) => r.body.error).sort()).toEqual(["challenge not found or expired", "passkey not found"]);
    const [row] = (await fixture`
      SELECT consumed_at IS NOT NULL AS consumed FROM admin_webauthn_challenge WHERE challenge = ${challenge}`) as unknown as {
      consumed: boolean;
    }[];
    expect(row).toEqual({ consumed: true });
  });

  test("a consumed challenge cannot be replayed", async () => {
    const issued = await call("GET", "/api/admin/webauthn/auth/options");
    const challenge = issued.body.challenge as string;
    expect((await verifyWith(challenge)).body.error).toBe("passkey not found");
    expect((await verifyWith(challenge)).body.error).toBe("challenge not found or expired");
  });

  test("an expired challenge is not accepted, though its slot still holds it", async () => {
    const issued = await call("GET", "/api/admin/webauthn/auth/options");
    const challenge = issued.body.challenge as string;
    await fixture`UPDATE admin_webauthn_challenge SET expires_at = now() - interval '1 second' WHERE challenge = ${challenge}`;
    expect((await verifyWith(challenge)).body.error).toBe("challenge not found or expired");
    const [row] = (await fixture`
      SELECT consumed_at FROM admin_webauthn_challenge WHERE challenge = ${challenge}`) as unknown as { consumed_at: Date | null }[];
    expect(row).toEqual({ consumed_at: null });
    expect(await rowCount()).toBe(SLOTS);
  });
});

describe("a public flood cannot evict a pending passkey registration (each flow has its own slots)", () => {
  test("the slots are split by flow: 0..7 registration, 8..31 authentication, fixed by a CHECK", async () => {
    let code: string | undefined;
    try {
      await fixture`
        UPDATE admin_webauthn_challenge
           SET flow = 'authentication', challenge = 'wrong-flow-slot', issued_at = now(), expires_at = now() + interval '5 minutes'
         WHERE slot = 0`;
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe("23514");
  });

  test("a registration challenge issued before 40 unauthenticated auth/options requests is still consumed by register/verify", async () => {
    // A signed-in operator starts enrolling a passkey.
    const started = await call("GET", "/api/admin/webauthn/register/options", undefined, { "X-Admin-Token": operator });
    expect(started.status).toBe(200);
    const challenge = started.body.challenge as string;
    const [slot] = (await fixture`
      SELECT slot FROM admin_webauthn_challenge WHERE challenge = ${challenge} AND flow = 'registration'`) as unknown as {
      slot: number;
    }[];
    expect(slot!.slot).toBeLessThan(REGISTRATION_SLOTS);

    // Then anyone floods the public sign-in options, more than all 32 slots.
    const flood = await Promise.all(Array.from({ length: 40 }, () => call("GET", "/api/admin/webauthn/auth/options")));
    expect(flood.map((r) => r.status)).toEqual(Array(40).fill(200));
    expect(await rowCount()).toBe(SLOTS);

    // The enrolment's challenge survived: register/verify consumes it and only
    // then refuses the (deliberately empty) attestation. An evicted challenge
    // would be refused as "challenge not found or expired" before verification.
    const verified = await call(
      "POST",
      "/api/admin/webauthn/register/verify",
      {
        id: "no-attestation",
        rawId: "no-attestation",
        type: "public-key",
        response: {
          clientDataJSON: Buffer.from(JSON.stringify({ type: "webauthn.create", challenge })).toString("base64url"),
          attestationObject: "",
        },
      },
      { "X-Admin-Token": operator },
    );
    expect(verified).toEqual({ status: 400, body: { error: "passkey verification failed" } });
    const [row] = (await fixture`
      SELECT consumed_at IS NOT NULL AS consumed FROM admin_webauthn_challenge WHERE challenge = ${challenge}`) as unknown as {
      consumed: boolean;
    }[];
    expect(row).toEqual({ consumed: true });
  }, 60_000);
});

// A role's password is cluster state that outlives this file; put the baseline back (tests/support/cluster.ts).
restoreRoleBaselineAfterAll();
