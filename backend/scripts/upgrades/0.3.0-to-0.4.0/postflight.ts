import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Checker } from "../../lib/checks.ts";
import { runPostflightMain, type Db } from "../../lib/postflight-utils.ts";
import { deriveHostRole } from "../../lib/rollout-receipt.ts";
import { JUDGE_CONFIG_TABLE, JUDGEMENT_TABLE, RECEIPT_TABLE, TAG_GLOB, THIS_RELEASE_MIGRATIONS } from "./release.ts";

const dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(dir, "..", "..", "..", "..");
const receiptStep = process.argv.find((a) => a.startsWith("--emit-receipt="))?.split("=", 2)[1] ?? (process.argv.includes("--emit-receipt") ? "P8.postflight-prod" : undefined);

export async function runChecks(db: Db, { record }: Checker): Promise<void> {
  const migrations = (await db`SELECT name FROM schema_migrations WHERE name = ANY(${THIS_RELEASE_MIGRATIONS})`) as unknown as { name: string }[];
  const got = new Set(migrations.map((r) => r.name));
  const missing = THIS_RELEASE_MIGRATIONS.filter((name) => !got.has(name));
  record("migrations", missing.length ? "FAIL" : "PASS", missing.length ? `missing: ${missing.join(", ")}` : "all five v0.4.0 migrations recorded");
  const configs = (await db`SELECT id, mode, min_takes, model FROM swarm_judge_config`) as unknown as { id: number; mode: string; min_takes: number; model: string | null }[];
  const initial = configs.length === 1 && configs[0]?.id === 1 && configs[0]?.mode === "off" && configs[0]?.min_takes >= 1 && configs[0]?.model === null;
  record("judge-config", initial ? "PASS" : "FAIL", initial ? "one seeded, disabled judge config" : `unexpected judge config: ${JSON.stringify(configs)}`);
  const states = (await db`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'swarm_sessions_state_check'`) as unknown as { definition: string }[];
  record("judged-state", states[0]?.definition.includes("'judged'") ? "PASS" : "FAIL", "swarm_sessions state constraint admits judged");
  const triggers = (await db`
    SELECT c.relname AS table_name, t.tgname, t.tgenabled
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
     WHERE c.relname IN (${JUDGEMENT_TABLE}, ${RECEIPT_TABLE}) AND NOT t.tgisinternal
  `) as unknown as { table_name: string; tgname: string; tgenabled: string }[];
  const expected = [
    `${JUDGEMENT_TABLE}_append_only`, `${JUDGEMENT_TABLE}_append_only_row`,
    `${RECEIPT_TABLE}_append_only`, `${RECEIPT_TABLE}_append_only_row`,
    `${RECEIPT_TABLE}_immutable`, `${RECEIPT_TABLE}_immutable_row`,
  ];
  const absent = expected.filter((name) => !triggers.some((t) => t.tgname === name && t.tgenabled === "A"));
  record("immutable-history", absent.length ? "FAIL" : "PASS", absent.length ? `missing/not ENABLE ALWAYS: ${absent.join(", ")}` : "append-only and immutable triggers enabled always");
  const grants = (await db`
    SELECT table_name, privilege_type FROM information_schema.role_table_grants
     WHERE grantee = 'rm_worker' AND table_name IN (${JUDGE_CONFIG_TABLE}, ${JUDGEMENT_TABLE}, ${RECEIPT_TABLE})
       AND privilege_type IN ('INSERT','UPDATE','DELETE')
  `) as unknown as { table_name: string; privilege_type: string }[];
  record("worker-write-grants", grants.length ? "FAIL" : "PASS", grants.length ? `rm_worker still has: ${JSON.stringify(grants)}` : "rm_worker has no writes on judge tables");
}

runPostflightMain({ name: "postflight-0.4.0", runChecks,
  receipt: receiptStep ? { step: receiptStep, repoRoot, tagGlob: TAG_GLOB, hostRole: deriveHostRole(repoRoot).role } : undefined,
}).then((code) => process.exitCode = code);
