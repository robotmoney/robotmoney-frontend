// No lifecycle path writes a session in state `scheduled` (issue #1026,
// criterion 82 residual; system-scheduler-spec.md §4.1).
//
//   §4.1: "The session is `collecting` from its first instant. There is no
//    `scheduled` state and no 'brief opens later.'"
//
// Two halves, because either alone can be fooled:
//
//   * AT RUNTIME, every transition an epoch can go through — open, turnover,
//     settlement, an admin's deactivation and re-activation, a member joining
//     mid-epoch — is driven against a clean database, and no session row and
//     no session event ever carries `scheduled`. The same run proves the
//     epoch's roster (scheduler spec §4.3, admin-surface.md US-C3): seated at
//     open, immutable from that instant, absences recorded against it at
//     turnover, and a member activated mid-epoch seated in the NEXT epoch.
//   * IN THE SOURCE, every SQL statement under backend/src that writes
//     `swarm_sessions` with the literal `'scheduled'` is found by parsing, and
//     the set of writers is pinned. The retired admin session create
//     (`createSessionAdmin`) was one; it is deleted (D55 decision 4). The one
//     writer left is `domain.openSession`, the legacy fixture helper ~20 older
//     test files still build sessions with — and the last test proves no
//     route, worker handler, scheduler or script reaches it. When those
//     fixtures move to openEpoch and it is deleted, the pinned set becomes
//     empty; it may only shrink.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { sql } from "../src/db/client.ts";
import * as ic from "../src/swarm/domain.ts";
import * as admin from "../src/swarm/admin.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeMember, activeSubject, sessionDate, sessionRow, setJudgeMode, submitTake } from "./support/epoch-fixtures.ts";

useCleanDatabase(import.meta.file);

const BACKEND = join(import.meta.dir, "..");
const REPO = join(BACKEND, "..");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** The enclosing named function of a node, for naming a writer. */
function enclosingFunction(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if (ts.isMethodDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer &&
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) return n.name.text;
  }
  return "<module>";
}

/** Every template literal under backend/src that writes swarm_sessions with the literal 'scheduled'. */
function scheduledWriters(): string[] {
  const writes = /\b(INSERT\s+INTO|UPDATE)\s+swarm_sessions\b/i;
  const found = new Set<string>();
  for (const file of tsFiles(join(BACKEND, "src"))) {
    const text = readFileSync(file, "utf8");
    if (!text.includes("'scheduled'")) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const literal = node.getText(source);
        if (writes.test(literal) && literal.includes("'scheduled'")) {
          found.add(`${relative(BACKEND, file)}:${enclosingFunction(node)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...found].sort();
}

test("at runtime: open, take, mid-epoch join, turnover, settlement, deactivation and re-activation never write `scheduled`", async () => {
  await setJudgeMode("off");
  const filer = await activeMember();
  const silent = await activeMember();
  const subjectId = await activeSubject("no_scheduled", 3600);

  const opened = await ic.openEpoch(subjectId);
  expect(opened.ok).toBe(true);
  if (!opened.ok) return;
  expect((await sessionRow(opened.sessionId)).state).toBe("collecting");
  const seatedIn = async (sessionId: string) => (await sql<{ member_id: string }[]>`
    SELECT member_id FROM swarm_session_members WHERE session_id = ${sessionId} AND status = 'expected'`)
    .map((r) => r.member_id).sort();
  // The epoch seated every active member in the transaction that opened it.
  expect(await seatedIn(opened.sessionId)).toEqual([filer.id, silent.id].sort());
  const date = sessionDate(await sessionRow(opened.sessionId));
  expect((await submitTake(filer, date, subjectId)).ok).toBe(true);

  // A member activated mid-epoch holds NO seat in it — the roster is immutable
  // from the open (US-C3) — so its take is refused, and it is not counted.
  const late = await activeMember();
  expect(await seatedIn(opened.sessionId)).toEqual([filer.id, silent.id].sort());
  expect(await submitTake(late, date, subjectId)).toMatchObject({
    ok: false, status: 403, error: "member is not on this session's expected roster",
  });

  // The boundary: N closes with its absences recorded against the seated
  // roster (§4.3) — the silent member filed nothing; the late one was never
  // seated, so it is not absent — and N+1 opens collecting, seating all three.
  const turned = await ic.turnOverEpoch(subjectId, opened.sessionId);
  expect(turned.ok).toBe(true);
  if (!turned.ok) return;
  const absent = await sql<{ member_id: string }[]>`
    SELECT member_id FROM swarm_agent_health_events WHERE session_id = ${opened.sessionId} AND event_type = 'absent'`;
  expect(absent.map((r) => r.member_id)).toEqual([silent.id]);
  expect((await sessionRow(turned.openedSessionId)).state).toBe("collecting");
  expect(await seatedIn(turned.openedSessionId)).toEqual([filer.id, silent.id, late.id].sort());
  expect((await submitTake(late, sessionDate(await sessionRow(turned.openedSessionId)), subjectId)).ok).toBe(true);

  // Settlement of N under judge mode `off`.
  expect((await ic.aggregateEpoch(opened.sessionId)).ok).toBe(true);
  expect((await ic.finalizeEpoch(opened.sessionId)).ok).toBe(true);
  expect((await sessionRow(opened.sessionId)).state).toBe("published");

  // An admin deactivates the subject, then activates it; the scheduler opens
  // its first epoch again.
  let [subject] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${subjectId}`;
  expect((await admin.deactivateSubjectAdmin(subjectId, Number(subject!.version))).ok).toBe(true);
  [subject] = await sql<{ version: number }[]>`SELECT version FROM swarm_subjects WHERE id = ${subjectId}`;
  expect((await admin.activateSubjectAdmin(subjectId, Number(subject!.version))).ok).toBe(true);
  const reopened = await ic.openEpoch(subjectId);
  expect(reopened.ok).toBe(true);

  const [{ sessions }] = await sql<{ sessions: number }[]>`
    SELECT count(*)::int AS sessions FROM swarm_sessions WHERE subject_id = ${subjectId}`;
  expect(sessions).toBe(3);
  const scheduledRows = await sql`SELECT id FROM swarm_sessions WHERE state = 'scheduled'`;
  expect(scheduledRows).toHaveLength(0);
  const scheduledEvents = await sql`
    SELECT id FROM swarm_session_events WHERE to_state = 'scheduled' OR from_state = 'scheduled'`;
  expect(scheduledEvents).toHaveLength(0);
});

test("the retired admin session create is gone: no module exports it, and no route reaches a session create", async () => {
  expect("createSessionAdmin" in admin).toBe(false);
  expect("TAKES_AMENDABLE_STATES" in ic).toBe(false);
  for (const file of tsFiles(join(BACKEND, "src"))) {
    expect(readFileSync(file, "utf8"), relative(REPO, file)).not.toMatch(/\bcreateSessionAdmin\s*\(/);
  }
});

test("in the source: the only statement under backend/src that writes `scheduled` into swarm_sessions is the legacy openSession fixture helper", () => {
  // RED CONTROL: the parser finds the writer that does exist, so an empty
  // answer elsewhere would be a real absence, not a blind scan.
  expect(scheduledWriters()).toEqual(["src/swarm/domain.ts:openSession"]);
});

test("no route, worker, scheduler or script calls openSession, so no runtime path can write `scheduled`", () => {
  const roots = [
    join(BACKEND, "src", "api"),
    join(BACKEND, "src", "worker"),
    join(BACKEND, "src", "producer"),
    join(BACKEND, "scripts"),
    join(REPO, "scripts"),
  ];
  const callers: string[] = [];
  for (const root of roots) {
    let files: string[] = [];
    try {
      files = tsFiles(root);
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.includes(`${join("scripts", "tests")}`)) continue;
      const text = readFileSync(file, "utf8");
      // A CALL of the domain function, not the `ROUTES.swarm.openSession`
      // route name (a read of the collecting session, GET only).
      if (/(?<![.\w]swarm\.)\bopenSession\s*\(/.test(text)) callers.push(relative(REPO, file));
    }
  }
  expect(callers).toEqual([]);
  // And within backend/src, only domain.ts defines or calls it.
  const inSrc = tsFiles(join(BACKEND, "src"))
    .filter((f) => /\bopenSession\s*\(/.test(readFileSync(f, "utf8")))
    .map((f) => relative(BACKEND, f));
  expect(inSrc).toEqual(["src/swarm/domain.ts"]);
});
