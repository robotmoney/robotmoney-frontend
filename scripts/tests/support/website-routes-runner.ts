// Runs the route and header table (website-routes-table.ts) against one origin
// and exits non-zero if any row fails (issue 1624).
//
//   ROUTES_TARGET_URL=http://127.0.0.1:8080 bun scripts/tests/support/website-routes-runner.ts [api-up|api-down]
//
// ROUTES_TARGET_URL is the only input that names the target, so the same table
// runs against any server: today's nginx image, its successor, or a stub. The
// argument picks the rows for the api's state (default api-up).
import { checkRow, TABLE, type Phase } from "./website-routes-table.ts";

const origin = process.env.ROUTES_TARGET_URL;
if (!origin) {
  console.error("ROUTES_TARGET_URL is required, for example http://127.0.0.1:8080");
  process.exit(2);
}
const phase = (process.argv[2] ?? "api-up") as Phase;
if (phase !== "api-up" && phase !== "api-down") {
  console.error(`phase must be api-up or api-down, got ${phase}`);
  process.exit(2);
}

const rows = TABLE.filter((r) => r.phase === phase);
let failed = 0;
for (const row of rows) {
  const problems = await checkRow(origin, row).catch((err: unknown) => [`request failed: ${String(err)}`]);
  if (problems.length === 0) {
    console.log(`ok   ${row.id} ${row.path}`);
  } else {
    failed++;
    console.log(`FAIL ${row.id} ${row.path}: ${problems.join("; ")}`);
  }
}
console.log(`${rows.length - failed}/${rows.length} rows passed (${phase}) against ${origin}`);
process.exit(failed === 0 && rows.length > 0 ? 0 : 1);
