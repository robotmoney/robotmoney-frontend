// W4.5 — the API automation-token store (issue #1026).
//
// AUTHORITY: docs/technical/smoke-production-spec.md §3, and
// docs/technical/system-scheduler-spec.md §7.
//
//   "The token is issued by the API's own automation-token store: a row holding
//    the token's hash and its rights (read subjects and sessions, perform
//    lifecycle transitions), written by the same authorized preparation that
//    writes `deployment_identity`. The API validates a presented token against
//    that row; a file on disk establishes nothing by itself ... Each instance
//    holds its own token, so provisioning one never invalidates another's.
//    Rotation is a re-provision and a container restart."
//
// D52 amended §3 to three holders — "`system-scheduler` ..., `analytics-producer`
// (the analytics ingestion routes), and the operator (the admin routes)" — each
// "a store-issued row with hash and rights". Migration 0078 keyed the store on
// (instance, holder); the third block below proves three holders coexist on one
// instance, each confined to its own rights, and that rotating one leaves the
// other two valid.
//
// The last two blocks are criteria 117 and 118 of #1026, proven against the
// RUNNING api (`bun run src/api/index.ts`), not a handler module:
//   117 — the three service tokens are validated against the store, and the
//         retired env credentials (ADMIN_TOKEN, ANALYTICS_TOKEN,
//         AUTOMATION_TOKEN, RM_ALLOW_INSECURE) are gone from backend/src and
//         inert when set on the process;
//   118 — each holder's token opens its own route family and no other: walking
//         every entry of contract/src/routes.js, a token outside its rights is
//         answered exactly as a forged one is, so none substitutes for another
//         or for a member bearer (scheduler spec §7, D55 (4)).
//
// The DELIVERY half — the boot placing a per-instance file in the state
// directory, journalled, never rotated by a rerun — is W1's criterion in
// scripts/tests/unit/smoke-state.test.ts. This file owns the API side only.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import { config } from "../src/config.ts";
import * as admin from "../src/swarm/admin.ts";
import * as epoch from "../src/swarm/domain.ts";
import { automationTokenGrant, hasAutomationRight } from "../src/api/auth.ts";
import { hashKey } from "../src/lib/keys.ts";
import {
  AUTOMATION_HOLDERS,
  AUTOMATION_RIGHTS,
  HOLDER_RIGHTS,
  lookupAutomationToken,
  provisionAutomationToken,
} from "../src/db/automation-tokens.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject } from "./support/epoch-fixtures.ts";
import {
  bootApi,
  everyHeader,
  probe,
  provisionAnalyticsToken,
  provisionOperatorToken,
  provisionSchedulerToken,
  writeRedControlPreload,
  type ApiProcess,
} from "./support/automation-auth.ts";

useCleanDatabase(import.meta.file);

// The scheduler's three rights (scheduler spec §7). Every case below that
// predates migration 0078 provisions the default holder, `system-scheduler`,
// which may hold these and nothing else.
const SCHEDULER_RIGHTS = HOLDER_RIGHTS["system-scheduler"];

const req = (token: string | null) =>
  new Request("http://test/api/swarm/admin/epochs/turnover", {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });

test("provisioning stores the hash and the rights, never the secret", async () => {
  const { token } = await provisionAutomationToken("rm_prod_scheduler", [...SCHEDULER_RIGHTS]);
  expect(token.length).toBeGreaterThan(20);

  const [row] = await sql<{ token_hash: string; rights: string[] }[]>`
    SELECT token_hash, rights FROM automation_tokens WHERE instance = 'rm_prod_scheduler'`;
  expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(row.rights.sort()).toEqual([...SCHEDULER_RIGHTS].sort());

  // The secret appears nowhere in the row, in any column.
  const [all] = await sql<Record<string, unknown>[]>`
    SELECT * FROM automation_tokens WHERE instance = 'rm_prod_scheduler'`;
  expect(JSON.stringify(all)).not.toContain(token);
});

test("a presented bearer is validated against the store", async () => {
  const { token } = await provisionAutomationToken("rm_stage_scheduler", [...SCHEDULER_RIGHTS]);
  const grant = await automationTokenGrant(req(token));
  expect(grant).not.toBeNull();
  expect(grant!.instance).toBe("rm_stage_scheduler");
  expect(await hasAutomationRight(req(token), "lifecycle_transitions")).toBe(true);
});

test("a file on disk grants nothing by itself: an unknown token is refused", async () => {
  await provisionAutomationToken("rm_known", [...SCHEDULER_RIGHTS]);
  const forged = "rmat_" + "f".repeat(40);
  expect(await automationTokenGrant(req(forged))).toBeNull();
  expect(await hasAutomationRight(req(forged), "lifecycle_transitions")).toBe(false);
  expect(await hasAutomationRight(req(null), "lifecycle_transitions")).toBe(false);
});

test("rights are enforced, not merely recorded", async () => {
  const { token } = await provisionAutomationToken("rm_reader", ["read_subjects", "read_sessions"]);
  expect(await hasAutomationRight(req(token), "read_sessions")).toBe(true);
  expect(await hasAutomationRight(req(token), "lifecycle_transitions")).toBe(false);
});

test("an unknown right cannot be provisioned", async () => {
  await expect(
    provisionAutomationToken("rm_bad_rights", ["drop_the_database" as never]),
  ).rejects.toThrow();
  expect((await sql`SELECT 1 FROM automation_tokens WHERE instance = 'rm_bad_rights'`).length).toBe(0);
});

test("a token with no rights at all cannot be provisioned", async () => {
  await expect(provisionAutomationToken("rm_no_rights", [])).rejects.toThrow();
});

test("provisioning one instance never invalidates another's", async () => {
  const first = await provisionAutomationToken("rm_ci_a", [...SCHEDULER_RIGHTS]);
  const second = await provisionAutomationToken("rm_ci_b", [...SCHEDULER_RIGHTS]);
  expect(first.token).not.toBe(second.token);
  expect(await hasAutomationRight(req(first.token), "lifecycle_transitions")).toBe(true);
  expect(await hasAutomationRight(req(second.token), "lifecycle_transitions")).toBe(true);
  expect((await automationTokenGrant(req(first.token)))!.instance).toBe("rm_ci_a");
  expect((await automationTokenGrant(req(second.token)))!.instance).toBe("rm_ci_b");
});

test("rotation is a re-provision: the new token works and the old one stops", async () => {
  const before = await provisionAutomationToken("rm_rotate", [...SCHEDULER_RIGHTS]);
  const after = await provisionAutomationToken("rm_rotate", [...SCHEDULER_RIGHTS]);
  expect(after.token).not.toBe(before.token);
  expect(await hasAutomationRight(req(after.token), "lifecycle_transitions")).toBe(true);
  expect(await hasAutomationRight(req(before.token), "lifecycle_transitions")).toBe(false);
  // One row per instance — a rotation replaces, it does not accumulate.
  const rows = await sql`SELECT 1 FROM automation_tokens WHERE instance = 'rm_rotate'`;
  expect(rows.length).toBe(1);
});

test("the store authorizes the epoch lifecycle routes, and a rightless token does not", async () => {
  const { handleSwarmAdmin } = await import("../src/api/routes/swarm-admin.ts");
  const full = await provisionAutomationToken("rm_route_full", [...SCHEDULER_RIGHTS]);
  const reader = await provisionAutomationToken("rm_route_reader", ["read_sessions"]);

  const call = (token: string) => {
    const url = new URL("http://test/api/swarm/admin/epochs/turnover");
    return handleSwarmAdmin(
      new Request(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ subjectId: "nope", expectedSessionId: "00000000-0000-4000-8000-000000000000" }),
      }),
      url,
    );
  };

  // The rightless token never reaches the handler.
  expect((await call(reader.token))!.status).toBe(403);
  // The full token does, and is refused on the MERITS instead.
  expect((await call(full.token))!.status).not.toBe(403);
});

// ─────────────────────────────────────────────────────────────────────────────
// Three holders per instance (smoke spec §3 as amended by D52, migration 0078)
// ─────────────────────────────────────────────────────────────────────────────

/** Provision all three holders on one instance, each with its full list. */
async function provisionAllHolders(instance: string) {
  const scheduler = await provisionAutomationToken(instance, [...HOLDER_RIGHTS["system-scheduler"]]);
  const producer = await provisionAutomationToken(instance, [...HOLDER_RIGHTS["analytics-producer"]], {
    holder: "analytics-producer",
  });
  const operator = await provisionAutomationToken(instance, [...HOLDER_RIGHTS.operator], { holder: "operator" });
  return { scheduler, producer, operator };
}

test("one instance holds three tokens, one row per holder, each with only its own rights", async () => {
  const { scheduler, producer, operator } = await provisionAllHolders("rm_three_holders");

  const rows = await sql<{ holder: string; rights: string[] }[]>`
    SELECT holder, rights FROM automation_tokens WHERE instance = 'rm_three_holders' ORDER BY holder`;
  expect(rows.map((r) => ({ holder: r.holder, rights: [...r.rights].sort() }))).toEqual([
    { holder: "analytics-producer", rights: ["analytics_ingestion"] },
    { holder: "operator", rights: ["admin"] },
    { holder: "system-scheduler", rights: [...HOLDER_RIGHTS["system-scheduler"]].sort() },
  ]);

  // Each presented secret resolves to its own holder, and to nothing wider.
  expect(await lookupAutomationToken(scheduler.token)).toEqual({
    instance: "rm_three_holders",
    holder: "system-scheduler",
    rights: [...HOLDER_RIGHTS["system-scheduler"]],
  });
  expect(await lookupAutomationToken(producer.token)).toEqual({
    instance: "rm_three_holders",
    holder: "analytics-producer",
    rights: ["analytics_ingestion"],
  });
  expect(await lookupAutomationToken(operator.token)).toEqual({
    instance: "rm_three_holders",
    holder: "operator",
    rights: ["admin"],
  });

  // Enforced through the same gate the routes use, for every right any holder
  // may carry: a token authorizes exactly its holder's list.
  for (const [holder, token] of [
    ["system-scheduler", scheduler.token],
    ["analytics-producer", producer.token],
    ["operator", operator.token],
  ] as const) {
    for (const right of AUTOMATION_RIGHTS) {
      const expected = (HOLDER_RIGHTS[holder] as readonly string[]).includes(right);
      expect({ holder, right, granted: await hasAutomationRight(req(token), right) }).toEqual({
        holder,
        right,
        granted: expected,
      });
    }
  }
});

test("re-provisioning one holder rotates that holder only — the other two stay valid", async () => {
  const before = await provisionAllHolders("rm_rotate_one_holder");
  const rotated = await provisionAutomationToken("rm_rotate_one_holder", ["admin"], { holder: "operator" });

  expect(rotated.token).not.toBe(before.operator.token);
  expect(await lookupAutomationToken(before.operator.token)).toBeNull();
  expect((await lookupAutomationToken(rotated.token))?.holder).toBe("operator");
  expect((await lookupAutomationToken(before.scheduler.token))?.holder).toBe("system-scheduler");
  expect((await lookupAutomationToken(before.producer.token))?.holder).toBe("analytics-producer");
  expect(await hasAutomationRight(req(before.scheduler.token), "lifecycle_transitions")).toBe(true);
  expect(await hasAutomationRight(req(before.producer.token), "analytics_ingestion")).toBe(true);

  const [count] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM automation_tokens WHERE instance = 'rm_rotate_one_holder'`;
  expect(count?.n).toBe(3);
});

test("a holder cannot be provisioned another holder's right — the module refuses and so does the table", async () => {
  // Module half: the scheduler holds one API credential and no other kind (§3).
  await expect(provisionAutomationToken("rm_cross_rights", ["admin"])).rejects.toThrow("system-scheduler");
  await expect(
    provisionAutomationToken("rm_cross_rights", ["lifecycle_transitions"], { holder: "analytics-producer" }),
  ).rejects.toThrow("analytics-producer");
  await expect(
    provisionAutomationToken("rm_cross_rights", ["analytics_ingestion"], { holder: "operator" }),
  ).rejects.toThrow("operator");
  await expect(
    provisionAutomationToken("rm_cross_rights", ["admin"], { holder: "someone-else" as never }),
  ).rejects.toThrow("holder");

  // Table half: a statement that bypasses the module is still refused by
  // migration 0078's constraints — 23514 is check_violation.
  const hash = "a".repeat(64);
  for (const [holder, rights] of [
    ["system-scheduler", ["admin"]],
    ["analytics-producer", ["read_subjects"]],
    ["operator", ["lifecycle_transitions"]],
    ["someone-else", ["admin"]],
  ] as const) {
    const error = await sql`
      INSERT INTO automation_tokens (instance, holder, token_hash, rights)
      VALUES ('rm_cross_rights', ${holder}, ${hash}, ${[...rights]})`.catch((e: { code?: string }) => e);
    expect({ holder, code: (error as { code?: string }).code }).toEqual({ holder, code: "23514" });
  }
  expect((await sql`SELECT 1 FROM automation_tokens WHERE instance = 'rm_cross_rights'`).length).toBe(0);
});

test("a row written with no holder is the scheduler's — the default keeps pre-0078 inserts meaning what they meant", async () => {
  const hash = "b".repeat(64);
  await sql`
    INSERT INTO automation_tokens (instance, token_hash, rights)
    VALUES ('rm_legacy_insert', ${hash}, ${["read_subjects"]})`;
  const [row] = await sql<{ holder: string }[]>`
    SELECT holder FROM automation_tokens WHERE instance = 'rm_legacy_insert'`;
  expect(row?.holder).toBe("system-scheduler");
  expect([...AUTOMATION_HOLDERS]).toEqual(["system-scheduler", "analytics-producer", "operator"]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Criterion 117: the retired env credentials are gone from backend/src
// ─────────────────────────────────────────────────────────────────────────────

const RETIRED_ENV = ["ADMIN_TOKEN", "ANALYTICS_TOKEN", "AUTOMATION_TOKEN", "RM_ALLOW_INSECURE"] as const;

/** Every way a module could read one of `names` from the environment. */
function envReads(text: string, names: readonly string[]): string[] {
  const alt = names.join("|");
  const re = new RegExp(
    [
      `\\benv\\.(${alt})\\b`, // process.env.X, env.X
      `\\benv\\[\\s*["'](${alt})["']\\s*\\]`, // env["X"]
      `envSecret\\(\\s*["'](${alt})["']`, // envSecret("X") — X or X_FILE
      // Any string literal naming it. Backticks are left out on purpose: in
      // this codebase they quote identifiers in comments, which read nothing.
      `["'](${alt})["']`,
    ].join("|"),
    "g",
  );
  return [...text.matchAll(re)].map((m) => m[0]);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.ts$/.test(name) ? [full] : [];
  });
}

test("117: no backend/src module reads ADMIN_TOKEN, ANALYTICS_TOKEN, AUTOMATION_TOKEN or RM_ALLOW_INSECURE", () => {
  const files = sourceFiles(join(import.meta.dir, "..", "src"));
  expect(files.length).toBeGreaterThan(50); // walker sanity
  const hits = files.flatMap((f) => envReads(readFileSync(f, "utf8"), RETIRED_ENV).map((h) => `${f}: ${h}`));
  expect(hits).toEqual([]);
  // The config object carries no credential and no insecure switch.
  for (const key of ["adminToken", "analyticsToken", "automationToken", "allowInsecure"]) {
    expect(Object.keys(config)).not.toContain(key);
  }
});

test("117 red control: the scan finds each retired read shape it claims to find", () => {
  // The exact lines this change deleted from config.ts, plus the other shapes.
  const planted = [
    `adminToken: process.env.ADMIN_TOKEN || null,`,
    `automationToken: process.env.AUTOMATION_TOKEN || null,`,
    `analyticsToken: envSecret("ANALYTICS_TOKEN"),`,
    `allowInsecure: process.env.RM_ALLOW_INSECURE === "1",`,
    `token: env["ANALYTICS_TOKEN"],`,
  ].join("\n");
  expect(envReads(planted, RETIRED_ENV)).toHaveLength(5);
  // …and a comment naming a retired variable, or the file variable, is not a read.
  expect(envReads("// the retired `ADMIN_TOKEN`\nconst f = env.ANALYTICS_TOKEN_FILE;", RETIRED_ENV)).toEqual([]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Criteria 117 and 118 on the running api
// ─────────────────────────────────────────────────────────────────────────────

type Family = "public" | "member" | "admin" | "lifecycle" | "scheduler-read" | "analytics";
const PRIVILEGED: readonly Family[] = ["admin", "lifecycle", "scheduler-read", "analytics"];

// The admin namespace's deliberately public entries: the claim probe and the
// passkey/recovery login steps, which run before any credential exists.
const PUBLIC_ADMIN = new Set(["admin.isClaimed", "admin.webauthnAuthOptions", "admin.webauthnAuthVerify", "admin.passwordRecover"]);
// Member-bearer routes (a swarm_member_keys token, or a judge's).
const MEMBER = new Set([
  "swarm.submit",
  "swarm.memos",
  "swarm.memberProfile",
  "swarm.verifyToken",
  "swarm.participants.pending",
  "swarm.participants.judgeSubscribe",
  "swarm.participants.judgement",
]);
// Public reads and the unauthenticated onboarding doors.
const PUBLIC = new Set([
  "health", "version", "apiVersion",
  "projects.list", "projects.detail",
  "swarm.members", "swarm.waitlist", "swarm.member", "swarm.memberTakes", "swarm.memberJudgements",
  "swarm.memberAvatar", "swarm.subject", "swarm.subjectSnapshots", "swarm.sessions", "swarm.session",
  "swarm.sessionById", "swarm.sessionConsensusReceipt", "swarm.sessionConsensusReceiptVerified",
  "swarm.sessionJudgements", "swarm.take", "swarm.takePermalink", "swarm.judgement", "swarm.openSession",
  "swarm.brief", "swarm.signingPayload", "swarm.memo", "swarm.apply", "swarm.applyStatus",
  "swarm.applicationStatus", "swarm.claimChallenge", "swarm.claimToken",
]);

/**
 * Which credential a contract entry is meant for. Every entry must answer: an
 * unclassified route fails the walk, so a route added to the contract cannot
 * escape it by not being on a list.
 */
function familyOf(key: string): Family | null {
  if (key.startsWith("analytics.") || key === "swarm.regime") return "analytics";
  if (key.startsWith("swarm.scheduler.")) return "scheduler-read";
  if (key.startsWith("swarm.admin.epoch")) return "lifecycle";
  if (key.startsWith("swarm.admin.") || key === "swarm.register" || key === "projects.adminUpdate") return "admin";
  if (key.startsWith("admin.")) return PUBLIC_ADMIN.has(key) ? "public" : "admin";
  if (MEMBER.has(key)) return "member";
  if (PUBLIC.has(key) || key.startsWith("dashboards.") || key.startsWith("comments.")) return "public";
  return null;
}

interface Entry {
  key: string;
  path: string;
  family: Family | null;
}

/** Every leaf of contract/src/routes.js, with its params filled. */
function contractEntries(node: unknown = ROUTES, prefix = ""): Entry[] {
  if (typeof node === "string") {
    const key = prefix.slice(1);
    return [{ key, path: node.replace(/:[a-zA-Z_]+/g, "x"), family: familyOf(key) }];
  }
  return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => contractEntries(v, `${prefix}.${k}`));
}

const ENTRIES = contractEntries();
const METHODS = ["GET", "POST", "PATCH"] as const;

// Set on the api process and presented by callers: each was a working
// credential before D52 (1), and none may be one now.
const LEGACY = {
  ADMIN_TOKEN: "legacy-admin-token",
  ANALYTICS_TOKEN: "legacy-analytics-token",
  AUTOMATION_TOKEN: "legacy-automation-token",
};

let api: ApiProcess;
let scheduler = "";
let analytics = "";
let operator = "";
beforeAll(async () => {
  scheduler = await provisionSchedulerToken();
  analytics = await provisionAnalyticsToken();
  operator = await provisionOperatorToken();
  api = await bootApi({ env: { ...LEGACY, RM_ALLOW_INSECURE: "1", RM_ENV: "ephemeral" } });
});
afterAll(() => api?.stop());

const forged = () => `rmat_${crypto.randomUUID().replace(/-/g, "")}`;

/**
 * The walk. For every contract entry in `families`, and every method, the
 * answer to `token` (presented in every credential header at once) must be
 * byte-identical to the answer to a forged token presented the same way. A
 * token that opened any door would get a different answer there — a 200, a
 * 400 from a body it was allowed to reach, a 404 from a lookup it was allowed
 * to make, a stream.
 */
async function substitutions(target: ApiProcess, token: string, families: readonly Family[]): Promise<string[]> {
  const leaks: string[] = [];
  for (const e of ENTRIES) {
    if (!e.family || !families.includes(e.family)) continue;
    for (const method of METHODS) {
      const body = method === "GET" ? undefined : {};
      const got = await probe(target, method, e.path, everyHeader(token), body);
      const baseline = await probe(target, method, e.path, everyHeader(forged()), body);
      if (got.status !== baseline.status || got.body !== baseline.body) {
        leaks.push(`${method} ${e.key} (${e.path}): ${got.status} ${got.body.slice(0, 80)} vs forged ${baseline.status}`);
      }
    }
  }
  return leaks;
}

test("118: every contract route is classified by the credential it admits", () => {
  expect(ENTRIES.length).toBeGreaterThan(100);
  expect(ENTRIES.filter((e) => e.family === null).map((e) => e.key)).toEqual([]);
  // The five epoch transitions are the lifecycle family, and nothing else is.
  expect(ENTRIES.filter((e) => e.family === "lifecycle").map((e) => e.key).sort()).toEqual([
    "swarm.admin.epochAggregate",
    "swarm.admin.epochFinalize",
    "swarm.admin.epochOpen",
    "swarm.admin.epochRequestJudging",
    "swarm.admin.epochTurnover",
  ]);
});

test("118 is not vacuous: every privileged route refuses a forged credential (401/403), even under RM_ALLOW_INSECURE=1", async () => {
  const open: string[] = [];
  for (const e of ENTRIES.filter((x) => x.family && PRIVILEGED.includes(x.family))) {
    let refused = false;
    for (const method of METHODS) {
      const r = await probe(api, method, e.path, everyHeader(forged()), method === "GET" ? undefined : {});
      if (r.status === 401 || r.status === 403) refused = true;
      expect({ route: `${method} ${e.key}`, success: r.status < 300 }).toEqual({ route: `${method} ${e.key}`, success: false });
    }
    if (!refused) open.push(e.key);
  }
  expect(open).toEqual([]);
}, 120_000);

test("118: a full-rights scheduler token substitutes for nothing outside its rights — admin, analytics or member", async () => {
  expect(await substitutions(api, scheduler, ["admin", "analytics", "member"])).toEqual([]);
}, 120_000);

test("118: the analytics token opens only the analytics routes — not admin, not the scheduler's, not a member's", async () => {
  expect(await substitutions(api, analytics, ["admin", "lifecycle", "scheduler-read", "member"])).toEqual([]);
}, 120_000);

test("118: the operator's admin token opens only the admin routes — not analytics, not the scheduler's, not a member's", async () => {
  expect(await substitutions(api, operator, ["analytics", "lifecycle", "scheduler-read", "member"])).toEqual([]);
}, 120_000);

test("117: the retired env credentials, set on the api process, open nothing", async () => {
  for (const value of Object.values(LEGACY)) {
    expect(await substitutions(api, value, PRIVILEGED)).toEqual([]);
  }
}, 120_000);

test("117: the api validates all three service tokens against the store — each opens its own family", async () => {
  const status = async (path: string, headers: Record<string, string>) => (await probe(api, "GET", path, headers)).status;
  expect(await status(ROUTES.admin.overview, { "X-Admin-Token": operator })).toBe(200);
  expect(await status(ROUTES.analytics.readiness, { Authorization: `Bearer ${analytics}` })).toBe(200);
  expect(await status(ROUTES.swarm.scheduler.fullRead, { "X-Automation-Token": scheduler })).toBe(200);
  // A rotation is a re-provision: the rotated-out operator token stops at once.
  const [{ instance }] = await sql<{ instance: string }[]>`
    SELECT instance FROM automation_tokens WHERE token_hash = ${hashKey(operator)}`;
  const rotated = await provisionAutomationToken(instance, ["admin"], { holder: "operator" });
  expect(await status(ROUTES.admin.overview, { "X-Admin-Token": rotated.token })).toBe(200);
  expect(await status(ROUTES.admin.overview, { "X-Admin-Token": operator })).toBe(403);
  operator = rotated.token;
});

/** A subject row, its sessions and the stream head — everything an activation or a deactivation moves. */
async function subjectState(id: string) {
  const [row] = await sql<{ status: string; version: number }[]>`SELECT status, version FROM swarm_subjects WHERE id = ${id}`;
  const sessions = await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${id}`;
  return { status: row!.status, version: Number(row!.version), sessions: sessions.length, head: await epoch.streamHeadSequence() };
}

const subjectEdit = (target: ApiProcess, route: string, id: string, version: number, headers: Record<string, string>) =>
  probe(target, "POST", route.replace(":id", encodeURIComponent(id)), headers, { expectedVersion: version });

test("118 (§4.5, §13): the scheduler's token cannot activate or deactivate a subject, and nothing moves", async () => {
  const active = await activeSubject("tok_deact");
  const inactive = await activeSubject("tok_act");
  expect((await admin.deactivateSubjectAdmin(inactive, (await subjectState(inactive)).version)).status).toBe(200);

  for (const [route, id] of [
    [ROUTES.swarm.admin.subjectDeactivate, active],
    [ROUTES.swarm.admin.subjectActivate, inactive],
  ] as const) {
    const before = await subjectState(id);
    for (const headers of [everyHeader(scheduler), { "X-Automation-Token": scheduler }]) {
      const res = await subjectEdit(api, route, id, before.version, headers);
      expect({ route, status: res.status }).toEqual({ route, status: 403 });
    }
    expect(await subjectState(id)).toEqual(before);
  }

  // Control: the same call under the operator's admin token is an edit.
  const before = await subjectState(active);
  const res = await subjectEdit(api, ROUTES.swarm.admin.subjectDeactivate, active, before.version, { "X-Admin-Token": operator });
  expect(res.status).toBe(200);
  expect((await subjectState(active)).status).toBe("inactive");
});

test("118 RED CONTROL: with the scheduler's token admitted to the admin routes again, the walk and the subject gate both fail", async () => {
  // The shape criterion 118 was written against: swarm-admin.ts's non-epoch
  // guard admitted a non-admin automation credential (`hasAutomationRole`),
  // so the scheduler's token could deactivate a subject. Restore exactly that
  // — a scheduler right standing in for `admin` — inside a real api process.
  const preload = writeRedControlPreload(
    "/src/api/routes/swarm-admin.ts",
    "} else if (!(await isPrivileged(req))) {",
    '} else if (!(await isPrivileged(req) || await hasAutomationRight(req, "read_subjects"))) {',
  );
  const broken = await bootApi({ env: { RM_ENV: "ephemeral" }, preload });
  try {
    const leaks = await substitutions(broken, scheduler, ["admin"]);
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks.some((l) => l.includes("swarm.admin.subjectDeactivate"))).toBe(true);

    const id = await activeSubject("tok_red");
    const before = await subjectState(id);
    const res = await subjectEdit(broken, ROUTES.swarm.admin.subjectDeactivate, id, before.version, {
      "X-Automation-Token": scheduler,
    });
    expect(res.status).toBe(200);
    expect(await subjectState(id)).not.toEqual(before);
  } finally {
    broken.stop();
  }
}, 180_000);
