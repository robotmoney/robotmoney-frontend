// The fixture projects source is reachable ONLY through the test seam (issue
// #973; issue #1208). Rows already persisted are purged by migration 0118 (D66).
//
// Why: production v0.5.4 ran RM_ENV=smoke without PROJECTS_SOURCE=live. The
// old selector threw only for prod, so it served the hermetic fixture and the
// projects worker persisted 4 fabricated projects, their wallets and vaults.
// The selector now has no environment class to consult: a process that did not
// inject a source through the armed seam gets the live source with
// PROJECTS_SOURCE=live and a refusal otherwise, whatever RM_ENV says.
//
// Every case runs in its own process, as a container does. The connection
// strings point at a closed port: the selector and the handlers must decide
// BEFORE any query, so a case that reached the database would fail with a
// connection error instead of the expected answer.
//
// Red controls: the same harness returns `live` for PROJECTS_SOURCE=live, and
// the armed process (this one, through tests/preload.ts) selects the injected
// fixture (tests/projects-hermeticity.test.ts), so a refusal below is the guard
// speaking, not a broken subprocess.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const BACKEND_DIR = join(import.meta.dir, "..");
const REFUSAL = "projects pipelines require PROJECTS_SOURCE=live — refusing to serve fixture data as production";
const RM_ENVS = ["smoke", "stage", "prod", "ephemeral", undefined] as const;
const label = (rmEnv: string | undefined) => (rmEnv === undefined ? "RM_ENV unset" : `RM_ENV=${rmEnv}`);

type Outcome = { kind: string } | { error: string };

function run(script: string, rmEnv: string | undefined, projectsSource: string | undefined): Outcome {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    DATABASE_URL: "postgres://rm_app:closed@127.0.0.1:1/none",
    WORKER_DATABASE_URL: "postgres://rm_worker:closed@127.0.0.1:1/none",
  };
  if (rmEnv !== undefined) env.RM_ENV = rmEnv;
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

describe("selectProjectsDataSource in a process that is not the armed harness", () => {
  for (const rmEnv of RM_ENVS) {
    for (const ps of [undefined, "fixture", ""]) {
      test(`${label(rmEnv)} with PROJECTS_SOURCE=${ps ?? "<unset>"} refuses`, () => {
        expect(run(SELECT, rmEnv, ps)).toEqual({ error: REFUSAL });
      });
    }
    test(`${label(rmEnv)} with PROJECTS_SOURCE=live selects the live source (control)`, () => {
      expect(run(SELECT, rmEnv, "live")).toEqual({ kind: "live" });
    });
  }
});

const INJECT = `
const { injectProjectsDataSource } = await import("./src/projects/access/select.ts");
const { fixtureProjectsDataSource } = await import("./src/projects/access/fixture-source.ts");
try { injectProjectsDataSource(fixtureProjectsDataSource); console.log(JSON.stringify({ kind: "injected" })); }
catch (e) { console.log(JSON.stringify({ error: e.message })); }
`;

describe("the fixture cannot be injected into a process that is not the armed harness", () => {
  for (const rmEnv of RM_ENVS) {
    test(`${label(rmEnv)}: injectProjectsDataSource refuses`, () => {
      const res = run(INJECT, rmEnv, "live");
      expect("error" in res ? res.error : res.kind).toMatch(/injectProjectsDataSource\(\) is a test-only seam and this process is not the test harness/);
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

describe("the projects pipelines refuse to run in a deployed process without PROJECTS_SOURCE=live", () => {
  for (const rmEnv of RM_ENVS) {
    test(`${label(rmEnv)}: every source-reading pipeline throws the refusal`, () => {
      const res = run(HANDLERS, rmEnv, undefined) as { kind: string };
      const byHandler = JSON.parse(res.kind) as Record<string, string>;
      for (const name of ["discover", "refreshCoins", "refreshWallets", "syncRevenue", "fetchVaults"]) {
        expect(byHandler[name]).toBe(REFUSAL);
      }
    });
  }
});
