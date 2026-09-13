// Runs the v0.5.0 postflight's real checks against a REALLY migrated
// database (the test harness's own clean clone — every migration through
// 0055 already applied by preload.ts), the same pattern
// aum-snapshot-foundation-migration.test.ts uses for the v0.3.0 postflight's
// checks. This is what actually proves the SQL in postflight.ts is correct —
// tsc only proves it typechecks.
import { describe, expect, test } from "bun:test";
import { sql } from "../src/db/client.ts";
import { createChecker } from "../scripts/lib/checks.ts";
import { runChecks as postflightChecks } from "../scripts/upgrades/0.4.0-to-0.5.0/postflight.ts";
import { runChecks as preflightChecks } from "../scripts/upgrades/0.4.0-to-0.5.0/preflight.ts";
import { THIS_RELEASE_MIGRATIONS } from "../scripts/upgrades/0.4.0-to-0.5.0/release.ts";
import { useCleanDatabasePerTest } from "./support/clean-db.ts";

// PER TEST, not per file: one test inserts a row into swarm_subjects, which
// migration 0032 makes append-only — there is no DELETE that could clean it
// back up for a later test in the same database.
useCleanDatabasePerTest(import.meta.file);

/**
 * The message a statement was REFUSED with, or "" when it succeeded.
 *
 * Deliberately a try/catch rather than `expect(...).rejects`: a postgres.js
 * query is a lazy thenable, not a Promise, and handing one to `.rejects` wedges
 * the test until its timeout instead of failing it. Awaiting the value first is
 * the difference between a red assertion and a five-second hang.
 */
async function refusal(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
    return "";
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe("v0.4.0 -> v0.5.0 postflight, against a fully migrated database", () => {
  test("every check passes, or WARNs only for the one legitimately optional case", async () => {
    const checker = createChecker("[test] ");
    await postflightChecks(sql as any, checker);
    const failed = checker.results.filter((r) => r.status === "FAIL");
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    const warned = checker.results.filter((r) => r.status === "WARN");
    // Neither robotmoney-vault nor robotmoney-allocation is part of the test
    // harness's seed data (they are created at runtime, not migrated) — see
    // subject-repair's own "absent is not a failure" note in postflight.ts.
    // judge-model-acceptance is the second: a freshly migrated database ships
    // the judge `off`, so there is no model in use to disqualify.
    expect(warned.map((r) => r.name).sort()).toEqual(["judge-model-acceptance", "subject-repair"]);
  });

  // AC-MODEL-01, asked of the database rather than of the code that writes it.
  // The setter refuses a free-family model now, but this command is what an
  // operator runs against a database whose whole history it did not watch — and
  // a `nemotron-3-ultra-free` judge satisfies BOTH of 0056's checks (non-empty
  // model, enabled-implies-model) while disqualifying the entire run.
  test("judge-model-acceptance: a free-family judge model FAILs, whatever the environment", async () => {
    await sql`UPDATE swarm_judge_config SET mode = 'enforce', model = 'nemotron-3-ultra-free' WHERE id = 1`;
    const savedEnv = process.env.RM_ENV;
    try {
      for (const env of ["ephemeral", "prod"]) {
        process.env.RM_ENV = env;
        const checker = createChecker("[test] ");
        await postflightChecks(sql as any, checker);
        const row = checker.results.find((r) => r.name === "judge-model-acceptance");
        expect(row?.status, `RM_ENV=${env}`).toBe("FAIL");
        expect(row?.detail[0]).toContain("keyless free-family model");
        // The two 0056 checks are GREEN on this same row — which is exactly why
        // this check had to exist.
        expect(checker.results.find((r) => r.name === "judge-enabled-implies-model")?.status).toBe("PASS");
        expect(checker.results.find((r) => r.name === "judge-model-constraint")?.status).toBe("PASS");
      }
    } finally {
      if (savedEnv === undefined) delete process.env.RM_ENV; else process.env.RM_ENV = savedEnv;
    }
  });

  test("judge-model-acceptance: the pinned model PASSes; any other FAILs on an acceptance path only", async () => {
    const savedEnv = process.env.RM_ENV;
    try {
      await sql`UPDATE swarm_judge_config SET mode = 'enforce', model = 'deepseek-v4-flash' WHERE id = 1`;
      for (const env of ["ephemeral", "prod"]) {
        process.env.RM_ENV = env;
        const checker = createChecker("[test] ");
        await postflightChecks(sql as any, checker);
        expect(checker.results.find((r) => r.name === "judge-model-acceptance")?.status, `pinned/${env}`).toBe("PASS");
      }

      await sql`UPDATE swarm_judge_config SET mode = 'enforce', model = 'kimi-k2.7-code' WHERE id = 1`;
      process.env.RM_ENV = "prod";
      let checker = createChecker("[test] ");
      await postflightChecks(sql as any, checker);
      let row = checker.results.find((r) => r.name === "judge-model-acceptance");
      expect(row?.status).toBe("FAIL");
      expect(row?.detail[0]).toContain("not the pinned");

      // Not an acceptance path: reported, never silent, but not a failure.
      process.env.RM_ENV = "ephemeral";
      checker = createChecker("[test] ");
      await postflightChecks(sql as any, checker);
      row = checker.results.find((r) => r.name === "judge-model-acceptance");
      expect(row?.status).toBe("WARN");
      expect(row?.detail[0]).toContain("kimi-k2.7-code");
    } finally {
      if (savedEnv === undefined) delete process.env.RM_ENV; else process.env.RM_ENV = savedEnv;
    }
  });

  // The append-only half: what was PRODUCED, not what is configured now. A
  // judgement row naming a free model means the run already ran on one, and
  // migration 0040 makes that row impossible to tidy away.
  test("judgements-no-free-model: one free-family judgement row FAILs the whole database", async () => {
    const checker0 = createChecker("[test] ");
    await postflightChecks(sql as any, checker0);
    expect(checker0.results.find((r) => r.name === "judgements-no-free-model")?.status).toBe("PASS");

    const subjectId = `free-model-probe-${crypto.randomUUID().slice(0, 8)}`;
    await sql`INSERT INTO swarm_subjects (id, name) VALUES (${subjectId}, 'Free Model Probe')`;
    const [session] = await sql`INSERT INTO swarm_sessions (subject_id) VALUES (${subjectId}) RETURNING id`;
    await sql`
      INSERT INTO swarm_session_judgements (session_id, mode, source, model, prompt_hash, inputs_digest, take_count, min_takes, opinion)
      VALUES (${session!.id}, 'enforce', 'model', 'nemotron-3-ultra-free', 'ph', 'id', 3, 3,
              ${sql.json({ rationale: "r", disagreements: [], release_safety: { release: "safe", concerns: [] } })})`;
    const checker = createChecker("[test] ");
    await postflightChecks(sql as any, checker);
    const row = checker.results.find((r) => r.name === "judgements-no-free-model");
    expect(row?.status).toBe("FAIL");
    expect(row?.detail[0]).toContain("nemotron-3-ultra-free x1");
  });

  test("subject-repair: FAILs once a subject exists and still reads the clobbered value", async () => {
    await sql`INSERT INTO swarm_subjects (id, name, recommendation_type) VALUES ('robotmoney-vault', 'RM Vault', 'position_actions')`;
    const checker = createChecker("[test] ");
    await postflightChecks(sql as any, checker);
    const row = checker.results.find((r) => r.name === "subject-repair");
    expect(row?.status).toBe("FAIL");
    expect(row?.detail[0]).toContain("robotmoney-vault=position_actions");
  });

  test("the security-relevant checks name what they actually found", async () => {
    const checker = createChecker("[test] ");
    await postflightChecks(sql as any, checker);
    const byName = Object.fromEntries(checker.results.map((r) => [r.name, r]));
    expect(byName["worker-write-allowlist"]?.status).toBe("PASS");
    expect(byName["no-public-schema-privilege"]?.status).toBe("PASS");
    expect(byName["member-keys-append-only"]?.status).toBe("PASS");
  });

  // ── Migration 0056 (issue #969 / AC-MODEL-01) ────────────────────────────
  // The invariant production violated for months: `swarm_judge_config` read
  // `mode = 'enforce'` with `model = NULL`, so resolveJudgeTransport() could
  // never build a transport and every published opinion was a template wearing
  // the judge's name. 0056 repairs the row and then constrains the pair; these
  // three tests grade the constraint, the repair, and the gate that reports
  // them — against a really-migrated database, which is the only thing that
  // proves the SQL rather than the types.

  test("0056's constraint is reported, validated, and really refuses the pair", async () => {
    const checker = createChecker("[test] ");
    await postflightChecks(sql as any, checker);
    const row = checker.results.find((r) => r.name === "judge-model-constraint");
    expect(row?.status).toBe("PASS");
    // Not just "a constraint exists": the definition names the rule and the
    // database says it validated it. A NOT VALID CHECK reads identically.
    expect(row?.detail[0]).toContain("validated=true");
    expect(row?.detail[0]).toContain("btrim(model)");

    // And the database really rejects the write, which no catalog read proves.
    // `swarm_judge_config` is a ONE-ROW table (`id smallint CHECK (id = 1)`,
    // migration 0039), so the operator action being modelled is an UPDATE of
    // that row — exactly what setJudgeConfig() issues.
    expect(await refusal(sql`UPDATE swarm_judge_config SET mode = 'enforce', model = NULL WHERE id = 1`))
      .toContain("swarm_judge_config_mode_requires_model_check");
    expect(await refusal(sql`UPDATE swarm_judge_config SET mode = 'shadow', model = NULL WHERE id = 1`))
      .toContain("swarm_judge_config_mode_requires_model_check");
    // Enabling WITH a model in the same statement is the supported act, and the
    // only one that can reach `enforce` — which is why scripts/lib/swarm/session.ts
    // sets mode and model together rather than in two requests.
    await sql`UPDATE swarm_judge_config SET mode = 'enforce', model = 'deepseek-v4-flash' WHERE id = 1`;
    // `off` with no model is the SHIPPED DEFAULT and must stay legal.
    await sql`UPDATE swarm_judge_config SET mode = 'off', model = NULL WHERE id = 1`;
  });

  test("judge-enabled-implies-model FAILs on the exact state production was found in", async () => {
    // The constraint cannot be violated through an INSERT any more, so the
    // row is forced into place the only way a real database could reach it:
    // with the constraint dropped, exactly as a restored pre-0056 snapshot or
    // a hand-run migration would leave it. That is precisely the case check 10
    // exists for, and it must not be provable by check 9 alone.
    await sql`ALTER TABLE swarm_judge_config DROP CONSTRAINT swarm_judge_config_mode_requires_model_check`;
    try {
      await sql`UPDATE swarm_judge_config SET mode = 'enforce', model = NULL WHERE id = 1`;
      const checker = createChecker("[test] ");
      await postflightChecks(sql as any, checker);
      const repair = checker.results.find((r) => r.name === "judge-enabled-implies-model");
      expect(repair?.status).toBe("FAIL");
      expect(repair?.detail[0]).toContain("still read enabled with no model");
      // …and the constraint check is FAIL too, naming its absence rather than
      // reporting a stale definition.
      const constraint = checker.results.find((r) => r.name === "judge-model-constraint");
      expect(constraint?.status).toBe("FAIL");
      expect(constraint?.detail[0]).toContain("is absent");
    } finally {
      await sql`UPDATE swarm_judge_config SET mode = 'off', model = NULL WHERE id = 1`;
      await sql`ALTER TABLE swarm_judge_config
        ADD CONSTRAINT swarm_judge_config_mode_requires_model_check
        CHECK (mode = 'off' OR (model IS NOT NULL AND btrim(model) <> ''))`;
    }
  });
});

describe("v0.4.0 -> v0.5.0 preflight, against the same fully migrated database", () => {
  test("correctly reports the target as no longer clean — this database already has v0.5.0 applied", async () => {
    // The inverse of postflight's assertion: preflight is meant to run against
    // a v0.4.0 baseline BEFORE migrating, so pointed at a database that
    // already has all eight migrations, its "nothing yet" checks must FAIL —
    // proving they are not silently vacuous PASSes.
    const checker = createChecker("[test] ");
    await preflightChecks(sql as any, checker);
    const byName = Object.fromEntries(checker.results.map((r) => [r.name, r]));
    expect(byName["clean-target"]?.status).toBe("FAIL");
    expect(byName["clean-target"]?.detail[0]).toContain(THIS_RELEASE_MIGRATIONS[0]);
    // 0056 is in the manifest, so it is in this list too — the gap this closes.
    expect(byName["clean-target"]?.detail[0]).toContain("0056_swarm_judge_requires_model.sql");
    expect(byName["v0.4-baseline"]?.status).toBe("PASS");
    // 0056 gets its own clean-target check, not just a manifest entry: the
    // constraint is the object this migration creates, exactly as 0055's index
    // and 0053's role are for theirs.
    expect(byName["clean-target-judge-constraint"]?.status).toBe("FAIL");
    expect(byName["clean-target-judge-constraint"]?.detail[0]).toContain("already exists");
  });

  test("judge-repair-preview warns BEFORE 0056 switches an enabled judge off", async () => {
    // An operator must not first learn that the judge was turned off from the
    // postflight. The preflight runs against a pre-0056 database, so the
    // constraint is dropped here to model one.
    await sql`ALTER TABLE swarm_judge_config DROP CONSTRAINT swarm_judge_config_mode_requires_model_check`;
    try {
      const clean = createChecker("[test] ");
      await preflightChecks(sql as any, clean);
      expect(clean.results.find((r) => r.name === "judge-repair-preview")?.status).toBe("PASS");

      await sql`UPDATE swarm_judge_config SET mode = 'enforce', model = NULL WHERE id = 1`;
      const checker = createChecker("[test] ");
      await preflightChecks(sql as any, checker);
      const preview = checker.results.find((r) => r.name === "judge-repair-preview");
      expect(preview?.status).toBe("WARN");
      expect(preview?.detail[0]).toContain("will switch them to 'off'");
      expect(preview?.detail[0]).toContain("mode AND model in one request");
    } finally {
      await sql`UPDATE swarm_judge_config SET mode = 'off', model = NULL WHERE id = 1`;
      await sql`ALTER TABLE swarm_judge_config
        ADD CONSTRAINT swarm_judge_config_mode_requires_model_check
        CHECK (mode = 'off' OR (model IS NOT NULL AND btrim(model) <> ''))`;
    }
  });
});
