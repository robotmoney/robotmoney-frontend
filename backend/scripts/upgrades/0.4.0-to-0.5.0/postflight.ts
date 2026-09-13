import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Checker } from "../../lib/checks.ts";
import { runPostflightMain, type Db } from "../../lib/postflight-utils.ts";
import { deriveHostRole } from "../../lib/rollout-receipt.ts";
import {
  DIGEST_SCHEME_COLUMN, DIGEST_SCHEME_DEFAULT, JUDGE_MODEL_CONSTRAINT, MEMBER_RECEIVED_INDEX, OWNER_ROLE,
  REPAIRED_RECOMMENDATION_TYPE, REPAIRED_SUBJECTS, RUNTIME_ROLES, SIGNING_KEY_COLUMN,
  TAG_GLOB, THIS_RELEASE_MIGRATIONS, WORKER_WRITABLE_TABLES,
} from "./release.ts";
import { COMMITTED_EVIDENCE_DIR } from "./steps.ts";
import { isAcceptanceJudgeEnv, isKeylessJudgeModel, PINNED_JUDGE_MODEL } from "../../../src/swarm/judge-model-policy.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");
const receiptStep = process.argv.find((a) => a.startsWith("--emit-receipt="))?.split("=", 2)[1] ?? (process.argv.includes("--emit-receipt") ? "P8.postflight-prod" : undefined);

export async function runChecks(db: Db, { record }: Checker): Promise<void> {
  // 1. All eight migrations recorded.
  const migrations = (await db`SELECT name FROM schema_migrations WHERE name = ANY(${THIS_RELEASE_MIGRATIONS})`) as unknown as { name: string }[];
  const got = new Set(migrations.map((r) => r.name));
  const missingMigrations = THIS_RELEASE_MIGRATIONS.filter((name) => !got.has(name));
  record("migrations", missingMigrations.length ? "FAIL" : "PASS",
    missingMigrations.length ? `missing: ${missingMigrations.join(", ")}` : "all eight v0.5.0 migrations recorded");

  // 2. 0049 — signing_key_id, nullable, FK to swarm_member_keys ON DELETE SET NULL.
  const fk = (await db`
    SELECT a.attname AS column_name, a.attnotnull AS not_null, con.confdeltype AS on_delete
      FROM pg_constraint con
      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
     WHERE con.conrelid = ${SIGNING_KEY_COLUMN.table}::regclass
       AND con.contype = 'f' AND con.confrelid = 'swarm_member_keys'::regclass
       AND a.attname = ${SIGNING_KEY_COLUMN.column}
  `) as unknown as { column_name: string; not_null: boolean; on_delete: string }[];
  const signingKeyRow = fk[0];
  record("signing-key-column", signingKeyRow && !signingKeyRow.not_null && signingKeyRow.on_delete === "n" ? "PASS" : "FAIL",
    signingKeyRow
      ? `nullable=${!signingKeyRow.not_null}, on_delete=${signingKeyRow.on_delete === "n" ? "SET NULL" : signingKeyRow.on_delete}`
      : `no FK from ${SIGNING_KEY_COLUMN.table}.${SIGNING_KEY_COLUMN.column} to swarm_member_keys found`);

  // 3. 0050 — swarm_member_keys carries the same append-only pair every other
  // protected table does. Not imported from src/db/append-only-guard.ts for
  // the same standalone reason every other check in this file is a raw
  // query — see postflight-utils.ts's header.
  const triggers = (await db`
    SELECT t.tgname AS name, t.tgenabled AS enabled, p.proname AS fn
      FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE t.tgrelid = 'swarm_member_keys'::regclass AND NOT t.tgisinternal
  `) as unknown as { name: string; enabled: string; fn: string }[];
  const expectedTriggers = ["swarm_member_keys_append_only", "swarm_member_keys_append_only_row"];
  const triggerProblems = expectedTriggers.filter((name) => {
    const row = triggers.find((t) => t.name === name);
    return !row || row.fn !== "rm_append_only_guard" || row.enabled !== "A";
  });
  record("member-keys-append-only", triggerProblems.length ? "FAIL" : "PASS",
    triggerProblems.length ? `missing/not ENABLE ALWAYS: ${triggerProblems.join(", ")}` : "both triggers present, ENABLE ALWAYS, calling rm_append_only_guard");

  // 4. 0051 — wherever either subject exists, it must read bucket_weights
  // again, never the clobbered 'position_actions'. ABSENT is not a failure:
  // a subject is created at runtime (ensureSubject/ensureSmokeSubjectFixtures),
  // not seeded by any migration, so a freshly migrated database that has not
  // convened either subject yet has nothing to repair — that is a legitimate
  // state on a smoke-twin or a brand-new environment, distinct from "exists
  // and still wrong", which is the actual failure this check exists for.
  const subjects = (await db`
    SELECT id, recommendation_type FROM swarm_subjects WHERE id = ANY(${[...REPAIRED_SUBJECTS] as string[]})
  `) as unknown as { id: string; recommendation_type: string }[];
  const wrongType = subjects.filter((s) => s.recommendation_type !== REPAIRED_RECOMMENDATION_TYPE);
  if (subjects.length === 0) {
    record("subject-repair", "WARN", "neither subject exists yet on this database — nothing to repair, not itself a failure");
  } else {
    record("subject-repair", wrongType.length === 0 ? "PASS" : "FAIL",
      wrongType.length
        ? `still wrong: ${wrongType.map((s) => `${s.id}=${s.recommendation_type}`).join(", ")}`
        : `${subjects.length} of ${REPAIRED_SUBJECTS.length} subject(s) present, all reading '${REPAIRED_RECOMMENDATION_TYPE}'`);
  }

  // 5. 0052 — digest_scheme, NOT NULL, defaulted, every row on file carries it.
  const digestCol = (await db`
    SELECT is_nullable, column_default FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ${DIGEST_SCHEME_COLUMN.table} AND column_name = ${DIGEST_SCHEME_COLUMN.column}
  `) as unknown as { is_nullable: string; column_default: string | null }[];
  const digestOk = digestCol[0] && digestCol[0].is_nullable === "NO" && (digestCol[0].column_default ?? "").includes(DIGEST_SCHEME_DEFAULT);
  record("digest-scheme-column", digestOk ? "PASS" : "FAIL",
    digestCol[0] ? `NOT NULL=${digestCol[0].is_nullable === "NO"}, default=${digestCol[0].column_default}` : "column absent");

  // 6. 0053 — role taxonomy. rm_owner is NOLOGIN and owns schema public and
  // every table/view in it; the runtime roles can log in; PUBLIC (the
  // pseudo-role, grantee OID 0 in an ACL) has no USAGE on schema public.
  const owner = (await db`SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ${OWNER_ROLE}`) as unknown as { rolname: string; rolcanlogin: boolean }[];
  record("owner-role", owner[0] && owner[0].rolcanlogin === false ? "PASS" : "FAIL",
    owner[0] ? `rolcanlogin=${owner[0].rolcanlogin}` : `role ${OWNER_ROLE} does not exist`);

  const runtimeLogins = (await db`SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY(${[...RUNTIME_ROLES] as string[]})`) as unknown as { rolname: string; rolcanlogin: boolean }[];
  const cantLogin = RUNTIME_ROLES.filter((name) => !runtimeLogins.find((r) => r.rolname === name && r.rolcanlogin));
  record("runtime-roles-login", cantLogin.length ? "FAIL" : "PASS",
    cantLogin.length ? `cannot log in: ${cantLogin.join(", ")}` : `${RUNTIME_ROLES.join(", ")} can all log in`);

  const schemaOwner = (await db`
    SELECT r.rolname FROM pg_namespace n JOIN pg_roles r ON r.oid = n.nspowner WHERE n.nspname = 'public'
  `) as unknown as { rolname: string }[];
  record("schema-owner", schemaOwner[0]?.rolname === OWNER_ROLE ? "PASS" : "FAIL",
    `schema public is owned by ${schemaOwner[0]?.rolname ?? "(unknown)"}`);

  const nonOwnerRelations = (await db`
    SELECT c.oid::regclass::text AS name FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m') AND r.rolname <> ${OWNER_ROLE}
  `) as unknown as { name: string }[];
  record("relation-ownership", nonOwnerRelations.length ? "FAIL" : "PASS",
    nonOwnerRelations.length ? `not owned by ${OWNER_ROLE}: ${nonOwnerRelations.map((r) => r.name).join(", ")}` : `every table/view/matview owned by ${OWNER_ROLE}`);

  const publicUsage = (await db`
    SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) a
     WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'USAGE'
  `) as unknown as unknown[];
  record("no-public-schema-privilege", publicUsage.length === 0 ? "PASS" : "FAIL",
    publicUsage.length === 0 ? "the PUBLIC pseudo-role has no USAGE on schema public" : "PUBLIC still has USAGE on schema public — REVOKE ALL ON SCHEMA public FROM PUBLIC did not take");

  // 7. 0054 — rm_worker's allow-list is EXACTLY WORKER_WRITABLE_TABLES: SELECT
  // everywhere, INSERT/UPDATE/DELETE nowhere else. This is the security-
  // relevant half of the release: judge/receipt/append-only tables must stay
  // unwritable by the worker role.
  // Set-compared by NAME, not counted: role_table_grants has one row per
  // (grantor, grantee, table), so a grant issued by a second grantor — which
  // 0054's `REVOKE ALL ... FROM rm_worker` does not remove, REVOKE only dropping
  // the invoker's own grants — inflates the count past the table total and
  // turns a table rm_worker genuinely cannot read into a PASS. The write check
  // below already compares sets; this is the same shape.
  const publicTables = (await db`
    SELECT c.relname AS table_name FROM pg_class c
      JOIN pg_namespace nsp ON nsp.oid = c.relnamespace
     WHERE nsp.nspname = 'public' AND c.relkind = 'r'
  `) as unknown as { table_name: string }[];
  const workerSelect = (await db`
    SELECT DISTINCT table_name FROM information_schema.role_table_grants
     WHERE grantee = 'rm_worker' AND privilege_type = 'SELECT' AND table_schema = 'public'
  `) as unknown as { table_name: string }[];
  const selectable = new Set(workerSelect.map((r) => r.table_name));
  const unreadable = publicTables.map((r) => r.table_name).filter((t) => !selectable.has(t)).sort();
  record("worker-read-everything", unreadable.length === 0 ? "PASS" : "FAIL",
    unreadable.length === 0
      ? `rm_worker has SELECT on all ${publicTables.length} public table(s)`
      : `rm_worker cannot SELECT ${unreadable.length} of ${publicTables.length} table(s): ${unreadable.join(", ")}`);

  const workerWrites = (await db`
    SELECT DISTINCT table_name FROM information_schema.role_table_grants
     WHERE grantee = 'rm_worker' AND privilege_type IN ('INSERT','UPDATE','DELETE')
  `) as unknown as { table_name: string }[];
  const writableSet = new Set(workerWrites.map((r) => r.table_name));
  const allowlistSet = new Set<string>(WORKER_WRITABLE_TABLES);
  const extra = [...writableSet].filter((t) => !allowlistSet.has(t));
  const missingWrite = [...allowlistSet].filter((t) => !writableSet.has(t));
  record("worker-write-allowlist", extra.length === 0 && missingWrite.length === 0 ? "PASS" : "FAIL",
    extra.length || missingWrite.length
      ? `extra=${JSON.stringify(extra)} missing=${JSON.stringify(missingWrite)}`
      : `rm_worker can write exactly the ${allowlistSet.size} allow-listed table(s)`);

  // 8. 0055 — the new index, on the right columns.
  const idx = (await db`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${MEMBER_RECEIVED_INDEX.index}`) as unknown as { indexdef: string }[];
  const idxOk = idx[0] && /\(member_id,\s*received_at DESC\)/.test(idx[0].indexdef);
  record("member-received-index", idxOk ? "PASS" : "FAIL",
    idx[0] ? idx[0].indexdef : `${MEMBER_RECEIVED_INDEX.index} does not exist`);

  // 9. 0056 — an enabled judge names a model. Checked separately from migration
  // presence, so a partially applied or hand-run deployment cannot pass on the
  // strength of a `schema_migrations` row alone.
  //
  // `convalidated` is read alongside the definition because a CHECK added
  // `NOT VALID` has a definition that reads exactly right and enforces nothing
  // against existing rows. The definition proves the RULE; convalidated proves
  // the database actually applied it.
  const judgeConstraint = (await db`
    SELECT pg_get_constraintdef(oid) AS definition, convalidated
      FROM pg_constraint
     WHERE conrelid = 'swarm_judge_config'::regclass
       AND conname = ${JUDGE_MODEL_CONSTRAINT}
  `) as unknown as { definition: string; convalidated: boolean }[];
  const judgeConstraintOk = judgeConstraint.length === 1 &&
    judgeConstraint[0]!.convalidated === true &&
    /mode.*off.*model IS NOT NULL/i.test(judgeConstraint[0]!.definition);
  record("judge-model-constraint", judgeConstraintOk ? "PASS" : "FAIL",
    judgeConstraint[0]
      ? `${judgeConstraint[0].definition} (validated=${judgeConstraint[0].convalidated})`
      : `${JUDGE_MODEL_CONSTRAINT} is absent`);

  // 10. 0056's REPAIR, which is the half the constraint cannot prove. The
  // constraint is attached AFTER the UPDATE that fixes the offending row, so a
  // database where the repair silently did nothing — because the table was
  // absent when 0056 ran, or because a snapshot was restored over it — would
  // still report a healthy constraint. The state itself is the check:
  // production reached `mode = 'enforce'` with `model = NULL` and stayed there
  // for months, and that is exactly what must be impossible afterwards.
  const enabledWithoutModel = (await db`
    SELECT count(*)::int AS n FROM swarm_judge_config
     WHERE mode <> 'off' AND (model IS NULL OR btrim(model) = '')
  `)[0] as { n: number };
  record("judge-enabled-implies-model", enabledWithoutModel.n ? "FAIL" : "PASS",
    enabledWithoutModel.n
      ? `${enabledWithoutModel.n} judge config row(s) still read enabled with no model after 0056`
      : "no judge config row is enabled without a model");

  // 11. WHICH model, not merely SOME model (AC-MODEL-01). Checks 9 and 10 prove
  // the column is non-empty and nothing more, so an enforce-mode judge pointed
  // at `nemotron-3-ultra-free` satisfies both and disqualifies the entire run:
  // "a run in which any agent used a free-tier model is not evidence". The
  // setter refuses it now (judge-model-policy.ts), but the setter is not the
  // only writer a database has ever had, and this command is what an operator
  // runs on a database whose history it did not watch.
  //
  // TWO STRENGTHS, matching the policy: the free family fails EVERYWHERE, and
  // the pinned-model requirement applies only where the judgements are evidence
  // (RM_ENV=prod, which staging and production both run). Elsewhere a non-pinned
  // id is reported as a WARN carrying the id, so the check is never silent.
  const judgeModelRow = (await db`
    SELECT mode, coalesce(btrim(model), '') AS model FROM swarm_judge_config WHERE id = 1
  `)[0] as { mode: string; model: string } | undefined;
  const configuredModel = judgeModelRow?.model ?? "";
  const acceptancePath = isAcceptanceJudgeEnv(process.env);
  if (!judgeModelRow || judgeModelRow.mode === "off") {
    record("judge-model-acceptance", "WARN",
      `judge mode=${judgeModelRow?.mode ?? "(no row)"} — no model is in use, so there is nothing to disqualify`);
  } else if (isKeylessJudgeModel(configuredModel)) {
    record("judge-model-acceptance", "FAIL",
      `judge is ${judgeModelRow.mode} on "${configuredModel}", a keyless free-family model — DISQUALIFIED for acceptance (AC-MODEL-01)`);
  } else if (configuredModel === PINNED_JUDGE_MODEL) {
    record("judge-model-acceptance", "PASS", `judge is ${judgeModelRow.mode} on the pinned "${PINNED_JUDGE_MODEL}"`);
  } else {
    record("judge-model-acceptance", acceptancePath ? "FAIL" : "WARN",
      `judge is ${judgeModelRow.mode} on "${configuredModel}", not the pinned "${PINNED_JUDGE_MODEL}"` +
        (acceptancePath ? " — AC-MODEL-01 requires the pinned model on an acceptance path" : " (not an acceptance path: RM_ENV is not prod)"));
  }

  // 12. And the same question asked of what was actually PRODUCED, not of what
  // is configured now: a judgement row naming a free-family model means the run
  // already ran on one, whatever the config says today. Append-only (0040), so
  // this cannot be tidied away — which is the point.
  const freeJudgements = (await db`
    SELECT coalesce(btrim(model), '') AS model, count(*)::int AS n
      FROM swarm_session_judgements
     WHERE model IS NOT NULL AND btrim(model) <> ''
     GROUP BY 1
  `) as unknown as { model: string; n: number }[];
  const disqualifying = freeJudgements.filter((r) => isKeylessJudgeModel(r.model));
  record("judgements-no-free-model", disqualifying.length ? "FAIL" : "PASS",
    disqualifying.length
      ? `judgement rows recorded on keyless free-family models: ${disqualifying.map((r) => `${r.model} x${r.n}`).join(", ")} — those sessions are not acceptance evidence (AC-MODEL-01)`
      : `no judgement row names a free-family model (${freeJudgements.length} distinct model id(s) on record)`);

}

// Only when RUN as a script — see preflight.ts's guard. rollout-postflight-0-5-0.test.ts
// imports `runChecks` from here, and without this the import ran the real postflight
// at test-file load and set process.exitCode = 2, which `bun test` preserves: the
// suite went red with every test passing.
if (import.meta.url === `file://${process.argv[1]}`) {
  runPostflightMain({ name: "postflight-0.5.0", runChecks,
    receipt: receiptStep ? { step: receiptStep, repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role, committedEvidenceDir: COMMITTED_EVIDENCE_DIR } : undefined,
  }).then((code) => process.exitCode = code);
}
