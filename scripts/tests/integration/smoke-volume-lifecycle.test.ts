// Demo postgres-data lifecycle (issue: smoke persistent volumes). Two layers:
//
//   1. OFFLINE compose-config assertions (pure `docker compose config` interpolation,
//      no containers): the smoke overlay stamps the robotmoney.smoke=1 + project labels
//      on the pgdata volume, and a `--pg-data`-style bind override merges by target
//      path to REPLACE the named-volume mount (so no named volume is used in bind mode).
//
//   2. An EXECUTED proof that boots ONLY postgres (never the api/worker, so NO
//      external providers / API quota are touched — respects the smoke's quota rule):
//      `down` (no -v) KEEPS the labeled volume, a re-`up` RESUMES the same data, and
//      `smoke:clean`'s real label-scoped removal then deletes exactly that volume.
//
// Docker is a hard dependency of this repo's test harness; a missing docker CLI fails
// loudly here — never a silent skip (test-coverage policy). Every executed test
// force-cleans its own project + volume in a finally/afterAll so it can never leak.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSmokeVolumes, makeDockerRunner, purgeSmokeEvalContainers, removeSmokeVolumes } from "../../lib/smoke-volumes.ts";
import { resolveStackEnvironment, stackProjectName } from "../../stack/naming.ts";

const repoRoot = join(import.meta.dir, "../../..");
const BASE = ["-f", "docker-compose.yml", "-f", "docker-compose.smoke.yml"];

// Unique, ENVIRONMENT-SCOPED project per run (scripts/stack/naming.ts) so
// nothing collides with the standing smoke on this host and anything this test
// leaks is attributable to the environment that ran it.
const environment = resolveStackEnvironment(process.env);
const project = `${stackProjectName("infra", environment)}_vol`;
const pgVolume = `${project}_pgdata`;

function composeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return {
    ...env,
    COMPOSE_PROJECT_NAME: project,
    SMOKE_PROJECT: project,
    RM_STACK_ENV_CLASS: environment.class,
    RM_STACK_ENV_HASH: environment.hash,
    DATABASE_URL: "postgres://robotmoney:robotmoney@postgres:5432/robotmoney",
    POSTGRES_USER: "robotmoney",
    POSTGRES_PASSWORD: "robotmoney",
    POSTGRES_DB: "robotmoney",
    // `${WEB_PORT:?…}` and `${POSTGRES_PORT:?…}` are REQUIRED inputs now (no default — see
    // scripts/stack/ports.ts).
    WEB_PORT: "18789",
    POSTGRES_PORT: "15432",
    ANALYTICS_TOKEN_FILE_HOST: "/dev/null", // compose-config/lifecycle fixture; no producer execution
    ...extra,
  };
}

function compose(args: string[], env: Record<string, string>): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["docker", "compose", ...BASE, ...args], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: new TextDecoder().decode(r.stdout), err: new TextDecoder().decode(r.stderr) };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

// --- 1. OFFLINE compose-config -------------------------------------------------

interface Cfg {
  services: Record<string, { volumes?: Array<{ type?: string; source?: string; target?: string }> }>;
  volumes: Record<string, { name?: string; labels?: Record<string, string> }>;
}
// The `--pg-data <dir>` override file, written exactly as smoke-main.ts writes
// it for that flag. Created here rather than inside the case that reads it so
// its path — and therefore the rendering that resolves it — is fixed and can be
// prewarmed below.
const pgDataDir = mkdtempSync(join(tmpdir(), "rmsmoke-pgdata-"));
const pgDataOverrideFile = join(pgDataDir, "pgdata.yml");
writeFileSync(
  pgDataOverrideFile,
  `services:\n  postgres:\n    volumes:\n      - ${pgDataDir}:/var/lib/postgresql/data\n`,
);

// ---------------------------------------------------------------------------
// ONE `docker compose config` RUN PER DISTINCT ARGUMENT SET (issue #809).
//
// The four offline cases below each read a RENDERED compose configuration, and
// rendering one shells out to the Docker CLI. On a cold GitHub-hosted runner
// that costs seconds — enough for the 5000 ms Bun gives a case that declares no
// timeout to expire on a diff that changed nothing here, which is exactly how
// PR #801's `unit` job went red at 5187 ms. Between them the four cases need
// only TWO distinct renderings, so `configJson` memoises on its full argument
// set and `beforeAll` pays for both once, outside any case's budget.
//
// The key keeps the two renderings apart on purpose: the `--pg-data` bind
// override resolves a DIFFERENT configuration from the default one, and serving
// one in place of the other would make a case pass while asserting against the
// wrong config — strictly worse than the flake this removes.
//
// The cache stores the raw JSON TEXT and re-parses per call, so each case gets
// its own object graph and none can leak a mutation into another.
//
// A missing or broken docker CLI throws in the hook and turns the file RED —
// never a silent skip (test-coverage policy).
const renderCache = new Map<string, string>();
let prewarmed = false;
/** Renders that missed the prewarm — see the regression guard at end of file. */
const coldRendersAfterPrewarm: string[] = [];

function renderKey(extraFiles: readonly string[], env: Record<string, string>): string {
  return JSON.stringify({
    files: [...extraFiles],
    env: Object.entries(env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  });
}

function configJson(extraFiles: string[], env: Record<string, string>): Cfg {
  const key = renderKey(extraFiles, env);
  let json = renderCache.get(key);
  if (json === undefined) {
    if (prewarmed) coldRendersAfterPrewarm.push(key);
    const r = Bun.spawnSync(
      ["docker", "compose", ...BASE, ...extraFiles, "config", "--format", "json"],
      { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
    );
    if (r.exitCode !== 0) throw new Error(`docker compose config failed (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr)}`);
    json = new TextDecoder().decode(r.stdout);
    renderCache.set(key, json);
  }
  return JSON.parse(json) as Cfg;
}

// Both renderings the offline cases ask for. A case that asks for one this list
// does not name is caught by the regression guard at the end of the file, not
// left to be rediscovered as a flake. Locally the two renders cost ~0.8 s; the
// 60 s budget is ~75x that, sized for a cold shared runner paying the Docker
// CLI's own start-up on the first render, and still bounded so a wedged Docker
// fails loudly instead of hanging.
const PREWARM: ReadonlyArray<readonly [string[], Record<string, string>]> = [
  [[], composeEnv()],
  [["-f", pgDataOverrideFile], composeEnv()],
];
const PREWARM_TIMEOUT_MS = 60_000;

beforeAll(() => {
  for (const [files, env] of PREWARM) configJson(files, env);
  prewarmed = true;
}, PREWARM_TIMEOUT_MS);

describe("smoke overlay — pgdata volume namespacing (offline)", () => {
  test("the pgdata volume carries robotmoney.smoke=1 + the project label", () => {
    const cfg = configJson([], composeEnv());
    const vol = cfg.volumes?.pgdata;
    expect(vol).toBeDefined();
    expect(vol.labels?.["robotmoney.smoke"]).toBe("1");
    expect(vol.labels?.["robotmoney.smoke.project"]).toBe(project);
    // …and the environment labels, so a volume left behind by a killed CI job
    // can be attributed to that job without parsing its name.
    expect(vol.labels?.["robotmoney.env"]).toBe(environment.class);
    expect(vol.labels?.["robotmoney.env.hash"]).toBe(environment.hash);
  });

  test("every smoke-overlay service carries the same environment labels as the volume", () => {
    const cfg = configJson([], composeEnv()) as unknown as {
      services: Record<string, { labels?: Record<string, string> }>;
    };
    for (const svc of ["postgres", "api", "worker-swarm", "worker-analytics", "worker-research"]) {
      const labels = cfg.services?.[svc]?.labels ?? {};
      expect({ svc, project: labels["robotmoney.smoke.project"] }).toEqual({ svc, project });
      expect({ svc, env: labels["robotmoney.env"] }).toEqual({ svc, env: environment.class });
      expect({ svc, hash: labels["robotmoney.env.hash"] }).toEqual({ svc, hash: environment.hash });
    }
  });

  test("postgres mounts the pgdata NAMED volume by default (no --pg-data)", () => {
    const cfg = configJson([], composeEnv());
    const mounts = cfg.services?.postgres?.volumes ?? [];
    const data = mounts.find((m) => m.target === "/var/lib/postgresql/data");
    expect(data?.type).toBe("volume");
  });
});

describe("--pg-data bind override merges by target (offline)", () => {
  test("a bind override REPLACES the named-volume mount on postgres", () => {
    // Renders the override file hoisted above — mirroring exactly what
    // smoke-main.ts writes for `--pg-data <dir>`.
    const cfg = configJson(["-f", pgDataOverrideFile], composeEnv());
    const mounts = cfg.services?.postgres?.volumes ?? [];
    const data = mounts.find((m) => m.target === "/var/lib/postgresql/data");
    // Merged by target path → the bind wins; the named-volume mount is gone.
    expect(data?.type).toBe("bind");
    expect(data?.source).toBe(pgDataDir);
    // And postgres no longer references the pgdata named volume at all.
    expect(mounts.some((m) => m.type === "volume" && m.target === "/var/lib/postgresql/data")).toBe(false);
  });
});

// --- 2. EXECUTED proof (postgres only) -----------------------------------------

// Force-clean this test's project + volume no matter how the run ended.
afterAll(() => {
  try {
    purgeSmokeEvalContainers(makeDockerRunner(composeEnv()), { project });
  } catch {}
  compose(["down", "-v"], composeEnv());
  makeDockerRunner(composeEnv())(["volume", "rm", "-f", pgVolume]);
}, 30_000);

function psql(env: Record<string, string>, sql: string): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(
    ["docker", "compose", ...BASE, "exec", "-T", "postgres", "psql", "-U", "robotmoney", "-d", "robotmoney", "-tAc", sql],
    { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: r.exitCode ?? -1,
    out: new TextDecoder().decode(r.stdout).trim(),
    err: new TextDecoder().decode(r.stderr).trim(),
  };
}

function waitPgReady(env: Record<string, string>, timeoutMs = 60_000): void {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    // pg_isready accepts the entrypoint's temporary server before its configured
    // database is queryable. Prove the actual database is ready, so a busy CI
    // runner cannot race initdb and then fail the very next statement.
    const r = psql(env, "SELECT 1;");
    if (r.code === 0 && r.out === "1") return;
    lastError = r.err || r.out || `exit ${r.code}`;
    Bun.sleepSync(1000);
  }
  throw new Error(`postgres did not accept a query within the deadline: ${lastError}`);
}

describe("teardown keeps the volume; resume converges; smoke:clean reclaims it (executed)", () => {
  test(
    "down (no -v) keeps labeled pgdata, re-up resumes marker, clean removes exactly it",
    async () => {
      const env = composeEnv({ POSTGRES_PORT: String(await freePort()) });
      const run = makeDockerRunner(env);

      // Boot postgres only (no api/worker → no external providers touched).
      expect(compose(["up", "-d", "postgres"], env).code).toBe(0);
      waitPgReady(env);

      // Write a marker so we can prove the data (not just the volume) survives.
      expect(psql(env, "CREATE TABLE resume_probe(x int); INSERT INTO resume_probe VALUES (42);").code).toBe(0);

      // Teardown = down WITHOUT -v → the volume must remain.
      expect(compose(["down"], env).code).toBe(0);
      const afterDown = listSmokeVolumes(run, { project });
      expect(afterDown.map((v) => v.name)).toContain(pgVolume);

      // Resume: same project/volume → the marker row is still there.
      expect(compose(["up", "-d", "postgres"], env).code).toBe(0);
      waitPgReady(env);
      expect(psql(env, "SELECT x FROM resume_probe;").out).toBe("42");

      // smoke:clean can't remove an in-use volume → loud skip while up.
      expect(compose(["down"], env).code).toBe(0); // stop first so it's free
      const found = listSmokeVolumes(run, { project });
      expect(found.map((v) => v.name)).toContain(pgVolume);
      const { removed, skipped } = removeSmokeVolumes(run, found.map((v) => v.name));
      expect(removed).toContain(pgVolume);
      expect(skipped).toEqual([]);

      // Scoped reclaim leaves zero for this project (the CI-leak guarantee).
      expect(listSmokeVolumes(run, { project })).toEqual([]);
    },
    120_000,
  );
});

// Issue #809's regression guard. Every offline case reads its compose
// configuration through `configJson`, which serves it from the prewarmed memo;
// a case that asks for a rendering `PREWARM` does not list falls back to
// shelling out to Docker inside its own 5000 ms budget, which is the flake this
// file was changed to remove. Declared last so every case has run.
describe("compose renders stay hoisted out of the case bodies (issue #809)", () => {
  test("no offline case shelled out to Docker on its own — every rendering was prewarmed", () => {
    // A failure lists the argument sets that missed. The fix is to add each one
    // to PREWARM, not to give the case a bigger timeout.
    expect(coldRendersAfterPrewarm).toEqual([]);
  });
});
