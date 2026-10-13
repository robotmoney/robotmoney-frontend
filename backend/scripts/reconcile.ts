// `bun run reconcile` — the ledger reconciliation as a command (D66;
// smoke-production-spec.md §8.1, §9.1). Read-only: one SELECT on
// schema_migrations, the migrations directory, git.
//
//   bun run --cwd backend reconcile [--pin-ref <tag|commit>] [--json] [--migrations-dir <dir>]
//
// It connects with DATABASE_URL, prints the receipt (`--json`: the JSON; else
// one line), and exits 0 only on verdict `ok`. `--pin-ref` turns check 3 on;
// a ref that does not resolve is `pin-ref-unresolved`, never a fallback.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { describeReconcile, runReconcile } from "../src/db/ledger-reconcile.ts";

const NAME = "reconcile";

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  if (at < 0) return undefined;
  const value = process.argv[at + 1];
  if (!value || value.startsWith("--")) {
    console.error(`[${NAME}] ${name} needs a value`);
    process.exit(2);
  }
  return value;
}

const pinRef = flag("--pin-ref");
const migrationsDir = resolve(flag("--migrations-dir") ?? join(dirname(fileURLToPath(import.meta.url)), "..", "migrations"));
const json = process.argv.includes("--json");
const url = process.env.DATABASE_URL;
if (!url) {
  console.error(`[${NAME}] DATABASE_URL is not set`);
  process.exit(2);
}

const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const receipt = await runReconcile({
    migrationsDir,
    db: sql,
    ...(pinRef === undefined ? {} : { pinRef }),
  });
  if (json) console.log(JSON.stringify(receipt, null, 2));
  else console.log(`[${NAME}] ${receipt.verdict}: ${describeReconcile(receipt)}`);
  process.exitCode = receipt.verdict === "ok" ? 0 : 1;
} finally {
  await sql.end({ timeout: 5 });
}
