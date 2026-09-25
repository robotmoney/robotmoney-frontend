// W4.1 — the subject's three scheduling columns (issue #1026).
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §2.2/§2.3/§2.4, §3 part 1,
// §6.2 and §9, as amended 2026-09-24 (§13, D52), and D53 decision 7.
//
//   §2.2: "Three columns on the subject define it, and they are the whole
//    schedule: `epoch_duration` … `epoch_anchor` … `judging_duration`." The
//    durations carry their unit as a suffix in the schema (D53 (7)):
//    `epoch_duration_seconds`, `judging_duration_seconds`.
//   §2.2: "Changing `epoch_duration` through the admin API also sets
//    `epoch_anchor` to the current window's `window_closes_at`, in the same
//    transaction; a subject with no open window keeps its anchor. The current
//    window is unchanged, and the grid continues from its close with the new
//    spacing."
//   §2.3: "On a blank database they are set by the bootstrap data in the schema
//    snapshot … Afterwards they are changed only through the admin API."
//   §2.4: "There is no on/off state for scheduling."
//   §6.2: `subject.changed` — "a scheduling column changed".
//
// NOT CLAIMED HERE: that the admin route is the ONLY writer. That is a claim
// about every statement in the process, and it is proved from the query
// registry by a later package (criterion 81's registry clause), not by a test
// that exercises one writer.
import { test, expect, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { sql } from "../src/db/client.ts";
import * as admin from "../src/swarm/admin.ts";
import * as epoch from "../src/swarm/domain.ts";
import { handleSwarmAdmin } from "../src/api/routes/swarm-admin.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject, refusedByDatabase, rid, sessionRow } from "./support/epoch-fixtures.ts";
import { adminHeaders, provisionOperatorToken } from "./support/automation-auth.ts";

useCleanDatabase(import.meta.file);

// Store-issued, like the real credential (smoke spec §3, D52 (1)); there is no
// env token and no insecure mode to fall back on.
let OPERATOR = "";
beforeAll(async () => {
  OPERATOR = await provisionOperatorToken();
});

const MIGRATION_0067 = new URL("../migrations/0067_subject_epoch_duration.sql", import.meta.url).pathname;
const SNAPSHOT = new URL("../schema/snapshot.sql", import.meta.url).pathname;
const COLUMNS = ["epoch_duration_seconds", "epoch_anchor", "judging_duration_seconds"] as const;

const versionOf = async (id: string) =>
  (await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${id}`)[0].version;

function adminPost(path: string, body: unknown) {
  const req = new Request(`http://x${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...adminHeaders(OPERATOR) },
    body: JSON.stringify(body),
  });
  return handleSwarmAdmin(req, new URL(req.url));
}

test("all three columns exist on swarm_subjects, NOT NULL, with a schema default", async () => {
  const cols = await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
    SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
     WHERE table_name = 'swarm_subjects' AND column_name = ANY(${[...COLUMNS]})
     ORDER BY column_name`;
  expect(cols.map((c) => c.column_name)).toEqual([...COLUMNS].sort());
  for (const c of cols) {
    expect({ column: c.column_name, nullable: c.is_nullable }).toEqual({ column: c.column_name, nullable: "NO" });
    expect(c.column_default, c.column_name).not.toBeNull();
  }
  const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
  expect(byName.epoch_duration_seconds.data_type).toBe("integer");
  expect(byName.judging_duration_seconds.data_type).toBe("integer");
  expect(byName.epoch_anchor.data_type).toBe("timestamp with time zone");
});

test("the schema snapshot declares all three, so a blank-database boot sets every subject's schedule", () => {
  // The snapshot (spec §8.1) is what a blank database is built from. No
  // bootstrap ROW carries the values because bootstrap-data.sql seeds no
  // subjects; the declarations' NOT NULL defaults are what make "every subject
  // has a schedule" true from the first instant. `includes`, not `toContain`:
  // the snapshot is ~200KB and a failing `toContain` renders all of it.
  const snapshot = readFileSync(SNAPSHOT, "utf8");
  expect(snapshot.includes("epoch_duration_seconds integer DEFAULT")).toBe(true);
  expect(snapshot.includes("epoch_anchor timestamp with time zone DEFAULT")).toBe(true);
  expect(snapshot.includes("judging_duration_seconds integer DEFAULT")).toBe(true);
  expect(snapshot.includes("swarm_subjects_epoch_duration_seconds_check")).toBe(true);
  expect(snapshot.includes("swarm_subjects_judging_duration_seconds_check")).toBe(true);
});

test("every subject on a freshly migrated database has all three, with positive durations", async () => {
  const [{ bad }] = await sql<{ bad: number }[]>`
    SELECT count(*)::int AS bad FROM swarm_subjects
     WHERE epoch_duration_seconds IS NULL OR epoch_duration_seconds <= 0
        OR judging_duration_seconds IS NULL OR judging_duration_seconds <= 0
        OR epoch_anchor IS NULL`;
  expect(bad).toBe(0);
});

test("there is no off switch: zero, negative and NULL are refused by the database for every column", async () => {
  const id = await activeSubject("dur_off");
  for (const column of ["epoch_duration_seconds", "judging_duration_seconds"]) {
    for (const bad of [0, -1, null]) {
      await refusedByDatabase(() => sql`UPDATE swarm_subjects SET ${sql(column)} = ${bad} WHERE id = ${id}`);
    }
  }
  await refusedByDatabase(() => sql`UPDATE swarm_subjects SET epoch_anchor = NULL WHERE id = ${id}`);
});

test("a subject created through the admin API carries all three without being given any", async () => {
  const id = rid("dur_new");
  const created = await admin.createSubjectAdmin({ id, name: "new subject" });
  expect(created.status).toBe(201);
  const subject = (created as any).subject;
  expect(subject.epochDuration).toBeGreaterThan(0);
  expect(subject.judgingDurationSeconds).toBeGreaterThan(0);
  expect(typeof subject.epochAnchor).toBe("string");
});

test("the admin create route accepts all three, and stores exactly what it was given", async () => {
  const id = rid("dur_create_all");
  const res = await adminPost("/api/swarm/admin/subjects", {
    id, name: "all three", epochDuration: 86_400, epochAnchor: "2026-01-01T22:45:00Z", judgingDurationSeconds: 600,
  });
  expect(res?.status).toBe(201);
  const [row] = await sql<{ d: number; j: number; anchored: boolean }[]>`
    SELECT epoch_duration_seconds AS d, judging_duration_seconds AS j,
           epoch_anchor = '2026-01-01T22:45:00Z'::timestamptz AS anchored
      FROM swarm_subjects WHERE id = ${id}`;
  expect(row).toEqual({ d: 86_400, j: 600, anchored: true });
});

test("the admin routes REFUSE a null, non-positive or malformed value for each column — never 'disabled', never the default", async () => {
  // §2.4. A `null` is not "use the default" and not "off": it is refused with
  // the field named, on create and on update, through the HTTP route (the
  // parser must not quietly drop it on the way in).
  const cases: [string, unknown][] = [
    ["epochDuration", null], ["epochDuration", 0], ["epochDuration", -5], ["epochDuration", 1.5], ["epochDuration", "60"],
    ["judgingDurationSeconds", null], ["judgingDurationSeconds", 0], ["judgingDurationSeconds", -1],
    ["judgingDurationSeconds", 2.5],
    ["epochAnchor", null], ["epochAnchor", "yesterday"], ["epochAnchor", "2026-01-01T22:45:00"], ["epochAnchor", 17],
  ];
  for (const [field, bad] of cases) {
    const id = rid("dur_bad_create");
    const created = await adminPost("/api/swarm/admin/subjects", { id, name: "bad", [field]: bad });
    expect({ field, bad, status: created?.status }).toEqual({ field, bad, status: 400 });
    expect(String((created!.body as { error: string }).error)).toContain(field);
    expect((await sql`SELECT 1 FROM swarm_subjects WHERE id = ${id}`).length).toBe(0);
  }

  const id = await activeSubject("dur_bad_update", 600);
  const before = await sql`SELECT epoch_duration_seconds, epoch_anchor, judging_duration_seconds, version
                             FROM swarm_subjects WHERE id = ${id}`;
  for (const [field, bad] of cases) {
    const updated = await adminPost(`/api/swarm/admin/subjects/${id}/update`, {
      expectedVersion: Number(before[0].version), [field]: bad,
    });
    expect({ field, bad, status: updated?.status }).toEqual({ field, bad, status: 400 });
  }
  const after = await sql`SELECT epoch_duration_seconds, epoch_anchor, judging_duration_seconds, version
                            FROM swarm_subjects WHERE id = ${id}`;
  expect(after).toEqual(before);
});

test("the admin subject route changes each column, versioned like every other field", async () => {
  const id = await activeSubject("dur_admin", 3600);
  const version = await versionOf(id);

  const stale = await admin.updateSubjectAdmin(id, version + 7, { epochDuration: 120 });
  expect(stale.status).toBe(409);
  expect((await sql`SELECT epoch_duration_seconds FROM swarm_subjects WHERE id = ${id}`)[0].epoch_duration_seconds)
    .toBe(3600);

  const ok = await admin.updateSubjectAdmin(id, version, {
    epochDuration: 120, judgingDurationSeconds: 45, epochAnchor: "2030-05-05T05:05:05Z",
  });
  expect(ok.status).toBe(200);
  const subject = (ok as any).subject;
  expect(subject.epochDuration).toBe(120);
  expect(subject.judgingDurationSeconds).toBe(45);
  expect(subject.epochAnchor).toBe("2030-05-05T05:05:05.000Z");
});

test("a DURATION CHANGE re-anchors the grid at the current window's close, in the same transaction, and publishes subject.changed", async () => {
  const id = await activeSubject("dur_reanchor", 600);
  const opened = await epoch.openEpoch(id);
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  const closeBefore = (await sql<{ c: string }[]>`
    SELECT window_closes_at::text AS c FROM swarm_sessions WHERE id = ${opened.sessionId}`)[0].c;
  const [{ head }] = await sql<{ head: string }[]>`SELECT COALESCE(MAX(seq), 0) AS head FROM swarm_stream_events`;

  const r = await admin.updateSubjectAdmin(id, await versionOf(id), { epochDuration: 90 });
  expect(r.status).toBe(200);

  // Re-anchored to the current close, to the microsecond; the current window
  // itself is unchanged.
  const [row] = await sql<{ anchored: boolean; unchanged: boolean }[]>`
    SELECT t.epoch_anchor = ${closeBefore}::text::timestamptz AS anchored,
           s.window_closes_at = ${closeBefore}::text::timestamptz AS unchanged
      FROM swarm_subjects t JOIN swarm_sessions s ON s.subject_id = t.id
     WHERE t.id = ${id} AND s.id = ${opened.sessionId}`;
  expect(row).toEqual({ anchored: true, unchanged: true });

  // In the SAME transaction as the edit: exactly one event, carrying the new
  // anchor and duration.
  const events = await sql<{ kind: string; payload: Record<string, unknown> }[]>`
    SELECT kind, payload FROM swarm_stream_events WHERE seq > ${Number(head)} ORDER BY seq`;
  expect(events.map((e) => e.kind)).toEqual(["subject.changed"]);
  expect(events[0].payload.epochDurationSeconds).toBe(90);
  expect(events[0].payload.epochAnchor).toBe(opened.windowClosesAt);

  // The next epoch uses the new spacing, continuing from the old close.
  const turned = await epoch.turnOverEpoch(id, opened.sessionId);
  expect(turned.ok).toBe(true);
  if (!turned.ok) return;
  const [next] = await sql<{ exact: boolean }[]>`
    SELECT window_closes_at = ${closeBefore}::text::timestamptz + interval '90 seconds' AS exact
      FROM swarm_sessions WHERE id = ${turned.openedSessionId}`;
  expect(next.exact).toBe(true);
});

test("a re-anchor is part of the edit's transaction: a refused edit moves neither duration nor anchor", async () => {
  const id = await activeSubject("dur_reanchor_refused", 600);
  const opened = await epoch.openEpoch(id);
  expect(opened.ok).toBe(true);
  const read = async () => [...await sql<{ d: number; a: string }[]>`
    SELECT epoch_duration_seconds AS d, epoch_anchor::text AS a FROM swarm_subjects WHERE id = ${id}`];
  const before = await read();
  const stale = await admin.updateSubjectAdmin(id, (await versionOf(id)) + 1, { epochDuration: 90 });
  expect(stale.status).toBe(409);
  expect(await read()).toEqual(before);
});

test("a subject with no open window keeps its anchor when its duration changes", async () => {
  const id = await activeSubject("dur_no_window", 600);
  await sql`UPDATE swarm_subjects SET epoch_anchor = '2026-03-03T03:03:03Z' WHERE id = ${id}`;
  const r = await admin.updateSubjectAdmin(id, await versionOf(id), { epochDuration: 120 });
  expect(r.status).toBe(200);
  expect((r as any).subject.epochAnchor).toBe("2026-03-03T03:03:03.000Z");
});

test("an anchor named in the same request as a duration change is the one stored", async () => {
  const id = await activeSubject("dur_named_anchor", 600);
  const opened = await epoch.openEpoch(id);
  expect(opened.ok).toBe(true);
  const r = await admin.updateSubjectAdmin(id, await versionOf(id), {
    epochDuration: 120, epochAnchor: "2026-04-04T04:04:04Z",
  });
  expect(r.status).toBe(200);
  expect((r as any).subject.epochAnchor).toBe("2026-04-04T04:04:04.000Z");
});

test("a judging-duration change leaves a session already settling on its captured value", async () => {
  // §10: "Changing `judging_duration` leaves a session already settling on its
  // captured value." The epoch-settlement file proves the deadline; this is
  // the admin half — the route's write does not reach the session.
  const id = await activeSubject("dur_judging_captured", 600);
  const opened = await epoch.openEpoch(id);
  if (!opened.ok) throw new Error("openEpoch failed");
  const turned = await epoch.turnOverEpoch(id, opened.sessionId);
  if (!turned.ok) throw new Error("turnOverEpoch failed");
  expect((await sessionRow(turned.closedSessionId)).judging_duration_seconds).toBe(900);
  const r = await admin.updateSubjectAdmin(id, await versionOf(id), { judgingDurationSeconds: 30 });
  expect(r.status).toBe(200);
  expect((await sessionRow(turned.closedSessionId)).judging_duration_seconds).toBe(900);
});

test("the full read serves every active subject with all three scheduling columns (§3 part 1)", async () => {
  const id = await activeSubject("dur_full_read", 777);
  await sql`UPDATE swarm_subjects SET epoch_anchor = '2026-02-02T02:02:02Z', judging_duration_seconds = 321
             WHERE id = ${id}`;
  const read = await epoch.fullRead();
  const row = read.subjects.find((s) => s.subjectId === id);
  expect(row).toEqual({
    subjectId: id,
    name: `${id.split("_").slice(0, -1).join("_")} subject`,
    epochDurationSeconds: 777,
    epochAnchor: "2026-02-02T02:02:02.000Z",
    judgingDurationSeconds: 321,
  });
});

test("a boot on a populated database changes no subject's duration", async () => {
  // Re-applying the migration is exactly what a boot on a populated database
  // would do if `schema_migrations` had not already recorded it — the strongest
  // available statement that the migration is not a seeder in disguise.
  const id = await activeSubject("dur_populated", 4242);
  await sql.unsafe(readFileSync(MIGRATION_0067, "utf8"));
  const [after] = await sql<{ epoch_duration_seconds: number }[]>`
    SELECT epoch_duration_seconds FROM swarm_subjects WHERE id = ${id}`;
  expect(after.epoch_duration_seconds).toBe(4242);
});
