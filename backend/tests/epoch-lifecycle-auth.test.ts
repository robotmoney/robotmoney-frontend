// The §13 gate of system-scheduler-spec.md (D55 (4), 2026-09-25): "a new gate
// asserts the operator admin token is refused on every epoch lifecycle route".
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §7 — "It is the only
// credential those transitions accept: the operator admin token holds only the
// `admin` right, and every epoch lifecycle route refuses it" — and §4.3/§4.5:
// only system-scheduler opens, turns over and settles an epoch; an admin edits
// subjects and never drives an epoch.
//
// WHAT IS PROVEN, AND WHERE. Against the RUNNING api (`bun run
// src/api/index.ts`), for every epoch entry of contract/src/routes.js — the
// walk reads the contract, so a sixth transition added there is walked too:
//   • the operator's store token, an admin session, the claimed admin
//     password, the retired env credentials (set on the process, with
//     RM_ALLOW_INSECURE=1) and no credential at all are each answered 403,
//     and no session, subject or stream event moves;
//   • system-scheduler's token is accepted on each (answered by the
//     transition, not by the guard), and `open` really opens an epoch;
//   • RED CONTROL: the same walk against an api whose epochs guard has the old
//     `isPrivileged(req) ||` restored finds the admin credentials admitted.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { ROUTES } from "@robotmoney/contract";
import { sql } from "../src/db/client.ts";
import * as epoch from "../src/swarm/domain.ts";
import { hashKey } from "../src/lib/keys.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject } from "./support/epoch-fixtures.ts";
import {
  bootApi,
  everyHeader,
  probe,
  provisionOperatorToken,
  provisionSchedulerToken,
  writeRedControlPreload,
  type ApiProcess,
} from "./support/automation-auth.ts";

useCleanDatabase(import.meta.file);

/** The contract's epoch entries — walked, not listed. */
const EPOCH_ROUTES = Object.entries(ROUTES.swarm.admin)
  .filter(([key]) => key.startsWith("epoch"))
  .map(([key, path]) => ({ key, path: path as string }));

const LEGACY = { ADMIN_TOKEN: "legacy-admin-token", AUTOMATION_TOKEN: "legacy-automation-token" };
const PASSWORD = "operator-chosen-password";

let api: ApiProcess;
let scheduler = "";
let operator = "";
let adminSession = "";
// A subject with no epoch (for `open`), and one with a collecting epoch (the
// target of turnover and settlement).
let idleSubject = "";
let runningSubject = "";
let runningSession = "";

beforeAll(async () => {
  scheduler = await provisionSchedulerToken();
  operator = await provisionOperatorToken();
  adminSession = `session_${randomUUID()}`;
  await sql`INSERT INTO admin_session (token, expires_at) VALUES (${hashKey(adminSession)}, now() + interval '1 hour')`;
  await sql`INSERT INTO admin_credential (id, pass_hash) VALUES (1, ${createHash("sha256").update(PASSWORD).digest("hex")})`;

  idleSubject = await activeSubject("lc_idle");
  runningSubject = await activeSubject("lc_running");
  const opened = await epoch.openEpoch(runningSubject);
  if (!opened.ok) throw new Error(`openEpoch failed: ${JSON.stringify(opened)}`);
  runningSession = opened.sessionId;

  api = await bootApi({ env: { ...LEGACY, RM_ALLOW_INSECURE: "1", RM_ENV: "ephemeral" } });
});
afterAll(() => api?.stop());

/** The body each transition would act on, if it were admitted. */
function bodyFor(key: string): Record<string, string> {
  switch (key) {
    case "epochOpen":
      return { subjectId: idleSubject };
    case "epochTurnover":
      return { subjectId: runningSubject, expectedSessionId: runningSession };
    default:
      return { sessionId: runningSession };
  }
}

/** Everything a transition moves: every session row, every subject row, the stream head. */
async function lifecycleState() {
  return {
    sessions: await sql`SELECT id, state, version, subject_id FROM swarm_sessions ORDER BY id`,
    subjects: await sql`SELECT id, status, version FROM swarm_subjects ORDER BY id`,
    head: await epoch.streamHeadSequence(),
  };
}

/** The credentials §7 says every epoch route refuses, each as its holder presents it. */
function refusedCredentials(): [string, Record<string, string>][] {
  return [
    ["operator admin token (X-Admin-Token)", { "X-Admin-Token": operator }],
    ["operator admin token (every header)", everyHeader(operator)],
    ["admin session", { "X-Admin-Token": adminSession }],
    ["claimed admin password", { "X-Admin-Token": PASSWORD }],
    ["retired env ADMIN_TOKEN", everyHeader(LEGACY.ADMIN_TOKEN)],
    ["retired env AUTOMATION_TOKEN", everyHeader(LEGACY.AUTOMATION_TOKEN)],
    ["no credential", {}],
  ];
}

/**
 * The walk: every refused credential on every epoch route. Returns what got
 * through — a non-403 answer, or any change to sessions, subjects or the
 * stream — so the gate and its red control read the same list.
 */
async function admitted(target: ApiProcess): Promise<string[]> {
  const through: string[] = [];
  for (const { key, path } of EPOCH_ROUTES) {
    for (const [who, headers] of refusedCredentials()) {
      const before = await lifecycleState();
      const res = await probe(target, "POST", path, headers, bodyFor(key));
      const after = await lifecycleState();
      if (res.status !== 403) through.push(`${key} admitted ${who}: ${res.status} ${res.body.slice(0, 80)}`);
      if (JSON.stringify(after) !== JSON.stringify(before)) through.push(`${key} under ${who} changed state`);
    }
  }
  return through;
}

test("the contract's epoch entries are the five transitions §4 names", () => {
  expect(EPOCH_ROUTES.map((r) => r.key).sort()).toEqual([
    "epochAggregate",
    "epochFinalize",
    "epochOpen",
    "epochRequestJudging",
    "epochTurnover",
  ]);
});

test("the refused credentials are real ones: each opens an admin route on the same api", async () => {
  // Without this, a 403 on the epoch routes could mean a broken credential.
  for (const headers of [{ "X-Admin-Token": operator }, { "X-Admin-Token": adminSession }, { "X-Admin-Token": PASSWORD }]) {
    expect((await probe(api, "GET", ROUTES.admin.overview, headers)).status).toBe(200);
  }
});

test("§13 gate: no admin credential, retired env credential or missing credential drives an epoch — 403, and nothing moves", async () => {
  expect(await admitted(api)).toEqual([]);
}, 120_000);

test("§7: system-scheduler's token is accepted on every epoch route, and `open` opens the epoch", async () => {
  const before = await lifecycleState();
  for (const { key, path } of EPOCH_ROUTES) {
    const res = await probe(api, "POST", path, { "X-Automation-Token": scheduler }, bodyFor(key));
    // Answered by the transition, whatever it decides — never by the guard.
    expect({ key, refusedByGuard: res.status === 401 || res.status === 403 }).toEqual({ key, refusedByGuard: false });
    expect({ key, envelope: "ok" in (JSON.parse(res.body) as object) }).toEqual({ key, envelope: true });
    if (key === "epochOpen") expect(res.status).toBe(201);
  }
  const opened = await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${idleSubject}`;
  expect(opened.length).toBe(1);
  expect(await epoch.streamHeadSequence()).toBeGreaterThan(before.head);
}, 60_000);

test("RED CONTROL: with `isPrivileged(req) ||` restored on the epochs guard, the walk finds the admin credentials admitted", async () => {
  // The guard as it stood before D55 (4) (swarm-admin.ts at 25db95d8), inside
  // a real api process on the same database.
  const preload = writeRedControlPreload(
    "/src/api/routes/swarm-admin.ts",
    'if (!(await hasAutomationRight(req, "lifecycle_transitions"))) return FORBIDDEN;',
    'if (!(await isPrivileged(req) || await hasAutomationRight(req, "lifecycle_transitions"))) return FORBIDDEN;',
  );
  const broken = await bootApi({ env: { RM_ENV: "ephemeral" }, preload });
  try {
    const idle = await activeSubject("lc_red");
    idleSubject = idle;
    const through = await admitted(broken);
    for (const who of ["operator admin token", "admin session", "claimed admin password"]) {
      expect({ who, admitted: through.some((t) => t.includes(who)) }).toEqual({ who, admitted: true });
    }
    // …and it really drove an epoch: the idle subject now has one.
    expect((await sql`SELECT id FROM swarm_sessions WHERE subject_id = ${idle}`).length).toBe(1);
    // The credentials the old guard never admitted stay refused even then.
    expect(through.some((t) => t.includes("no credential"))).toBe(false);
  } finally {
    broken.stop();
  }
}, 180_000);
