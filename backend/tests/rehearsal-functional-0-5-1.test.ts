// PROVE THE CRITERIA DISCRIMINATE.
//
// rollout-procedure.md §9.1 is explicit that a check must be shown to fail
// before its passing is worth anything ("dry-run the checks before cutover —
// prove the checks discriminate"). That matters more than usual here: v0.5.1's
// four functional criteria are the ONLY thing standing between "the stack
// booted" and "the release did what it claims", because a code-only release
// has no migration whose landing could be observed. A criterion that silently
// passed on an empty result set would convert the whole rehearsal into theatre.
//
// So every case below establishes the RED first and then the GREEN, against a
// real database, using the same function the rehearsal calls.
import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { sql } from "../src/db/client.ts";
import { createChecker } from "../scripts/lib/checks.ts";
import type { CheckResult } from "../scripts/lib/checks.ts";
import { runFunctionalRehearsal } from "../scripts/upgrades/0.5.0-to-0.5.1/functional-rehearsal.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

// Per TEST, not per file: every criterion here is a statement about the WHOLE
// session population, so one test's fixture is another's false failure — and
// swarm_sessions is append-only (0032), so a fixture cannot clean up after
// itself by deleting. A fresh template clone per test is the only isolation
// available, and it is the right one.
useCleanDatabasePerTest(import.meta.file);

/** One pass, no waiting: a deadline shorter than the poll interval makes the
 *  loop evaluate once and return. The polling behaviour is the rehearsal's,
 *  not the criterion's, and is not what these cases are about. */
async function grade(): Promise<Map<string, CheckResult>> {
  const checker = createChecker("");
  await runFunctionalRehearsal(sql as never, checker, {
    deadlineMs: 1,
    pollMs: 1_000,
    log: () => {},
  });
  return new Map(checker.results.map((r) => [r.name, r]));
}

async function seedSubject(): Promise<string> {
  const id = `subj-${randomUUID().slice(0, 8)}`;
  await sql`INSERT INTO swarm_subjects (id, name, status) VALUES (${id}, ${"Test Subject"}, ${"active"})`;
  return id;
}

/** A session convened in the past — i.e. before the twin's postmaster, which is
 *  how the rehearsal tells a restored row from one it produced. */
async function seedSession(subjectId: string, state: string, closedMinutesAgo: number | null): Promise<string> {
  const id = randomUUID();
  // `date` is GENERATED from convened_at (0022) — it cannot be inserted.
  await sql`
    INSERT INTO swarm_sessions (id, subject_id, subject_name, state, convened_at, window_closes_at)
    VALUES (
      ${id}, ${subjectId}, ${"Test Subject"}, ${state},
      now() - interval '30 days',
      ${closedMinutesAgo === null ? null : sql`now() - (${closedMinutesAgo} || ' minutes')::interval`}
    )`;
  return id;
}

describe("v0.5.1 criterion (a)/(b): a session past its close time must be closed", () => {
  test("RED: a session one minute past its window fails — there is no grace period", async () => {
    // One minute. The point of the case: an earlier revision allowed 30
    // minutes, which would have graded this row as healthy.
    const subject = await seedSubject();
    await seedSession(subject, "aggregated", 1);

    const r = await grade();
    expect(r.get("a-self-healed")?.status).toBe("FAIL");
    expect(r.get("b-expired-sessions-closed")?.status).toBe("FAIL");
    expect(JSON.stringify(r.get("b-expired-sessions-closed")?.detail)).toContain("1m overdue");
  });

  test("RED: every non-terminal state past the window fails, not just one", async () => {
    const subject = await seedSubject();
    for (const state of ["scheduled", "collecting", "window_closed", "aggregated", "judged"]) {
      await seedSession(subject, state, 120);
    }
    const r = await grade();
    expect(r.get("b-expired-sessions-closed")?.status).toBe("FAIL");
    // All five, not merely the first one found.
    expect(JSON.stringify(r.get("b-expired-sessions-closed")?.detail)).toContain("5 session(s)");
  });

  test("GREEN: the same sessions pass once they reach a terminal state", async () => {
    const subject = await seedSubject();
    const a = await seedSession(subject, "aggregated", 120);
    const b = await seedSession(subject, "judged", 120);
    expect((await grade()).get("b-expired-sessions-closed")?.status).toBe("FAIL");

    await sql`UPDATE swarm_sessions SET state = ${"published"} WHERE id = ${a}`;
    await sql`UPDATE swarm_sessions SET state = ${"cancelled"} WHERE id = ${b}`;

    const r = await grade();
    expect(r.get("a-self-healed")?.status).toBe("PASS");
    expect(r.get("b-expired-sessions-closed")?.status).toBe("PASS");
  });

  test("a session whose window has NOT yet closed is not overdue", async () => {
    // The boundary in the other direction: the criterion must not fail a
    // session that is simply still collecting.
    const subject = await seedSubject();
    await seedSession(subject, "collecting", -60); // window closes in an hour
    expect((await grade()).get("b-expired-sessions-closed")?.status).toBe("PASS");
  });

  test("a session with NO window is reported separately, never silently dropped", async () => {
    const subject = await seedSubject();
    await seedSession(subject, "collecting", null);
    const r = await grade();
    expect(r.get("b-expired-sessions-closed")?.status).toBe("PASS");
    expect(r.get("b-windowless-sessions")?.status).toBe("WARN");
  });
});

describe("v0.5.1 criteria (c)/(d): new work, and a full judged session", () => {
  test("RED: with no session convened after the postmaster, (c) and (d) both fail", async () => {
    // Every seeded row above is convened 30 days ago, so nothing counts as new.
    // This is the empty-result case that a naive implementation would pass.
    const r = await grade();
    expect(r.get("c-new-sessions-opened")?.status).toBe("FAIL");
    expect(r.get("d-full-session-judged")?.status).toBe("FAIL");
  });

  test("(c) passes on a session convened after the postmaster, but (d) still fails without a judgement", async () => {
    const subject = await seedSubject();
    const id = randomUUID();
    await sql`
      INSERT INTO swarm_sessions (id, subject_id, state, convened_at, window_closes_at)
      VALUES (${id}, ${subject}, ${"collecting"}, now(), now() + interval '1 hour')`;

    const r = await grade();
    expect(r.get("c-new-sessions-opened")?.status).toBe("PASS");
    // A new session alone is not the end-to-end claim.
    expect(r.get("d-full-session-judged")?.status).toBe("FAIL");
  });
});
