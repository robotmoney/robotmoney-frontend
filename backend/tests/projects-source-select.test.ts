// The fixture projects source is selectable ONLY under RM_ENV=ephemeral (issue
// #1208, owner decision 2026-10-08: guard only, no purge).
//
// Why: production v0.5.4 ran RM_ENV=smoke without PROJECTS_SOURCE=live. The
// selector threw only for prod, so it served the hermetic fixture and the
// projects worker persisted 4 fabricated projects, their wallets and vaults.
//
// config.env is read once at import, so every case runs in its own process with
// RM_ENV set the way a container sets it. The connection strings point at a
// closed port: the selector and the handlers must decide BEFORE any query, so a
// case that reached the database would fail with a connection error instead of
// the expected answer.
//
// Red controls: the same harness returns `fixture` for ephemeral and `live` for
// a deployed env with PROJECTS_SOURCE=live, so a refusal below is the guard
// speaking, not a broken subprocess. The pre-#1208 selector returned `fixture`
// for smoke and stage without PROJECTS_SOURCE=live, which these cases reject.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const BACKEND_DIR = join(import.meta.dir, "..");
const REFUSAL = (env: string) =>
  `projects pipelines require PROJECTS_SOURCE=live in ${env} — refusing to serve fixture data as production`;

type Outcome = { kind: string } | { error: string };

function run(script: string, rmEnv: string, projectsSource: string | undefined): Outcome {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    RM_ENV: rmEnv,
    DATABASE_URL: "postgres://rm_app:closed@127.0.0.1:1/none",
    WORKER_DATABASE_URL: "postgres://rm_worker:closed@127.0.0.1:1/none",
  };
  if (projectsSource !== undefined) env.PROJECTS_SOURCE = projectsSource;
  const proc = Bun.spawnSync([process.execPath, "-e", script], { cwd: BACKEND_DIR, env, stdout: "pipe", stderr: "pipe" });
  const out = proc.stdout.toString().trim();
  if (proc.exitCode !== 0 || !out) throw new Error(`subprocess failed (${proc.exitCode}): ${proc.stderr.toString()}`);
  return JSON.parse(out.split("\n").at(-1)!) as Outcome;
}

const SELECT = `
const { selectProjectsDataSource } = await import("./src/projects/access/select.ts");
try { console.log(JSON.stringify({ kind: selectProjectsDataSource().kind })); }
catch (e) { console.log(JSON.stringify({ error: e.message })); }
`;

describe("selectProjectsDataSource per RM_ENV", () => {
  for (const rmEnv of ["smoke", "stage", "prod"]) {
    for (const ps of [undefined, "fixture", ""]) {
      test(`${rmEnv} with PROJECTS_SOURCE=${ps ?? "<unset>"} refuses`, () => {
        expect(run(SELECT, rmEnv, ps)).toEqual({ error: REFUSAL(rmEnv) });
      });
    }
    test(`${rmEnv} with PROJECTS_SOURCE=live selects the live source (control)`, () => {
      expect(run(SELECT, rmEnv, "live")).toEqual({ kind: "live" });
    });
  }

  for (const ps of [undefined, "fixture", "live"]) {
    test(`ephemeral with PROJECTS_SOURCE=${ps ?? "<unset>"} selects the fixture (control)`, () => {
      expect(run(SELECT, "ephemeral", ps)).toEqual({ kind: "fixture" });
    });
  }
});

// The worker handlers resolve the source through the selector's default
// argument, so a deployed worker without PROJECTS_SOURCE=live refuses every
// projects pipeline before it reads or writes a row.
const HANDLERS = `
const h = await import("./src/worker/handlers/projects.ts");
const out = {};
for (const name of ["discover", "refreshCoins", "refreshWallets", "syncRevenue", "fetchVaults"]) {
  try { await h[name]({}); out[name] = "ran"; } catch (e) { out[name] = e.message; }
}
console.log(JSON.stringify({ kind: JSON.stringify(out) }));
`;

describe("the projects pipelines refuse to run on a deployed env without PROJECTS_SOURCE=live", () => {
  for (const rmEnv of ["smoke", "stage", "prod"]) {
    test(`${rmEnv}: every source-reading pipeline throws the refusal`, () => {
      const res = run(HANDLERS, rmEnv, undefined) as { kind: string };
      const byHandler = JSON.parse(res.kind) as Record<string, string>;
      for (const name of ["discover", "refreshCoins", "refreshWallets", "syncRevenue", "fetchVaults"]) {
        expect(byHandler[name]).toBe(REFUSAL(rmEnv));
      }
    });
  }
});
