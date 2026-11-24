// Issue 1742 (R4): a session dated before the configured judge model's training
// cutoff is refused. The guard is pure; one live case proves openEpoch still
// opens a session dated today with the pinned judge model configured.
import { describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import * as epoch from "../src/swarm/domain.ts";
import { MODEL_CUTOFF_DATES, PINNED_JUDGE_MODEL } from "../src/swarm/judge-model-policy.ts";
import { assertSessionNotBeforeModelCutoff, SessionBeforeModelCutoffError } from "../src/swarm/model-cutoff.ts";
import { useCleanDatabase } from "./support/clean-db.ts";
import { activeSubject } from "./support/epoch-fixtures.ts";

useCleanDatabase(import.meta.file);

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const TODAY = new Date().toISOString().slice(0, 10);

describe("assertSessionNotBeforeModelCutoff", () => {
  const cutoff = MODEL_CUTOFF_DATES[PINNED_JUDGE_MODEL]!;

  test("the pinned judge model declares a cutoff", () => {
    expect(cutoff).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("a date one day before the cutoff is refused with the named error and code", () => {
    let err: unknown;
    try {
      assertSessionNotBeforeModelCutoff(PINNED_JUDGE_MODEL, addDays(cutoff, -1), TODAY);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SessionBeforeModelCutoffError);
    expect((err as SessionBeforeModelCutoffError).code).toBe("session_before_model_cutoff");
  });

  test("the cutoff date and today are accepted", () => {
    expect(() => assertSessionNotBeforeModelCutoff(PINNED_JUDGE_MODEL, cutoff, TODAY)).not.toThrow();
    expect(() => assertSessionNotBeforeModelCutoff(PINNED_JUDGE_MODEL, TODAY, TODAY)).not.toThrow();
  });

  test("a model with no declared cutoff, or none configured, is refused for yesterday and accepted for today", () => {
    for (const model of ["no-such-model", null]) {
      expect(() => assertSessionNotBeforeModelCutoff(model, addDays(TODAY, -1), TODAY)).toThrow(SessionBeforeModelCutoffError);
      expect(() => assertSessionNotBeforeModelCutoff(model, TODAY, TODAY)).not.toThrow();
    }
  });
});

describe("live paths", () => {
  test("openEpoch for an active subject still returns a collecting session dated today with the pinned judge model configured", async () => {
    await sql`UPDATE swarm_judge_config SET model = ${PINNED_JUDGE_MODEL} WHERE id = 1`;
    const subjectId = await activeSubject("cutoff_open", 1800);
    const res = await epoch.openEpoch(subjectId);
    expect(res.ok).toBe(true);
    const [row] = await sql<{ state: string; date: string }[]>`
      SELECT state, date::text AS date FROM swarm_sessions WHERE subject_id = ${subjectId}`;
    expect(row!.state).toBe("collecting");
    expect(row!.date).toBe(TODAY);
  });

  test("publishBrief refuses a session dated before the cutoff", async () => {
    await sql`UPDATE swarm_judge_config SET model = ${PINNED_JUDGE_MODEL} WHERE id = 1`;
    const subjectId = await activeSubject("cutoff_publish", 1800);
    const session = await epoch.openSession(subjectId);
    await sql`UPDATE swarm_sessions SET convened_at = '2020-01-01T12:00:00Z' WHERE id = ${session.id}`;
    await expect(epoch.publishBrief(session.id, 60)).rejects.toBeInstanceOf(SessionBeforeModelCutoffError);
  });
});
