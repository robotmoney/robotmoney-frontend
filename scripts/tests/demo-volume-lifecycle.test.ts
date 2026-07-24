// Demo postgres-data lifecycle (issue: demo persistent volumes). Two layers:
//
//   1. OFFLINE compose-config assertions (pure `docker compose config` interpolation,
//      no containers): the demo overlay stamps the robotmoney.demo=1 + project labels
//      on the pgdata volume, and a `--pg-data`-style bind override merges by target
//      path to REPLACE the named-volume mount (so no named volume is used in bind mode).
//
//   2. An EXECUTED proof that boots ONLY postgres (never the api/worker, so NO
//      external providers / API quota are touched — respects the demo's quota rule):
//      `down` (no -v) KEEPS the labeled volume, a re-`up` RESUMES the same data, and
//      `demo:clean`'s real label-scoped removal then deletes exactly that volume.
//
// Docker is a hard dependency of this repo's test harness; a missing docker CLI fails
// loudly here — never a silent skip (test-coverage policy). Every executed test
// force-cleans its own project + volume in a finally/afterAll so it can never leak.
import { afterAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listDemoVolumes, makeDockerRunner, removeDemoVolumes } from "../lib/demo-volumes.ts";

const repoRoot = join(import.meta.dir, "../..");
const BASE = ["-f", "docker-compose.yml", "-f", "docker-compose.demo.yml"];

// Unique project per run so nothing collides with the standing demo on this host.
const project = `rmdemo_test_${crypto.randomUUID().slice(0, 8)}`;
const pgVolume = `${project}_pgdata`;

function composeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return {
    ...env,
    COMPOSE_PROJECT_NAME: project,
    DEMO_PROJECT: project,
    DATABASE_URL: "postgres://robotmoney:robotmoney@postgres:5432/robotmoney",
    POSTGRES_USER: "robotmoney",
    POSTGRES_PASSWORD: "robotmoney",
    POSTGRES_DB: "robotmoney",
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
function configJson(extraFiles: string[], env: Record<string, string>): Cfg {
  const r = Bun.spawnSync(
    ["docker", "compose", ...BASE, ...extraFiles, "config", "--format", "json"],
    { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(`docker compose config failed (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr)}`);
  return JSON.parse(new TextDecoder().decode(r.stdout)) as Cfg;
}

describe("demo overlay — pgdata volume namespacing (offline)", () => {
  test("the pgdata volume carries robotmoney.demo=1 + the project label", () => {
    const cfg = configJson([], composeEnv());
    const vol = cfg.volumes?.pgdata;
    expect(vol).toBeDefined();
    expect(vol.labels?.["robotmoney.demo"]).toBe("1");
    expect(vol.labels?.["robotmoney.demo.project"]).toBe(project);
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
    // Mirror exactly what demo-main.ts writes for `--pg-data <dir>`.
    const dir = mkdtempSync(join(tmpdir(), "rmdemo-pgdata-"));
    const overrideFile = join(dir, "pgdata.yml");
    writeFileSync(overrideFile, `services:\n  postgres:\n    volumes:\n      - ${dir}:/var/lib/postgresql/data\n`);
    const cfg = configJson(["-f", overrideFile], composeEnv());
    const mounts = cfg.services?.postgres?.volumes ?? [];
    const data = mounts.find((m) => m.target === "/var/lib/postgresql/data");
    // Merged by target path → the bind wins; the named-volume mount is gone.
    expect(data?.type).toBe("bind");
    expect(data?.source).toBe(dir);
    // And postgres no longer references the pgdata named volume at all.
    expect(mounts.some((m) => m.type === "volume" && m.target === "/var/lib/postgresql/data")).toBe(false);
  });
});

// --- 2. EXECUTED proof (postgres only) -----------------------------------------

// Force-clean this test's project + volume no matter how the run ended.
afterAll(() => {
  compose(["down", "-v"], composeEnv());
  makeDockerRunner(composeEnv())(["volume", "rm", "-f", pgVolume]);
});

function waitPgReady(env: Record<string, string>, timeoutMs = 60_000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = Bun.spawnSync(
      ["docker", "compose", ...BASE, "exec", "-T", "postgres", "pg_isready", "-U", "robotmoney", "-d", "robotmoney"],
      { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
    );
    if (r.exitCode === 0) return;
    Bun.sleepSync(1000);
  }
  throw new Error("postgres did not become ready within the deadline");
}

function psql(env: Record<string, string>, sql: string): { code: number; out: string } {
  const r = Bun.spawnSync(
    ["docker", "compose", ...BASE, "exec", "-T", "postgres", "psql", "-U", "robotmoney", "-d", "robotmoney", "-tAc", sql],
    { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" },
  );
  return { code: r.exitCode ?? -1, out: new TextDecoder().decode(r.stdout).trim() };
}

describe("teardown keeps the volume; resume converges; demo:clean reclaims it (executed)", () => {
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
      const afterDown = listDemoVolumes(run, { project });
      expect(afterDown.map((v) => v.name)).toContain(pgVolume);

      // Resume: same project/volume → the marker row is still there.
      expect(compose(["up", "-d", "postgres"], env).code).toBe(0);
      waitPgReady(env);
      expect(psql(env, "SELECT x FROM resume_probe;").out).toBe("42");

      // demo:clean can't remove an in-use volume → loud skip while up.
      expect(compose(["down"], env).code).toBe(0); // stop first so it's free
      const found = listDemoVolumes(run, { project });
      expect(found.map((v) => v.name)).toContain(pgVolume);
      const { removed, skipped } = removeDemoVolumes(run, found.map((v) => v.name));
      expect(removed).toContain(pgVolume);
      expect(skipped).toEqual([]);

      // Scoped reclaim leaves zero for this project (the CI-leak guarantee).
      expect(listDemoVolumes(run, { project })).toEqual([]);
    },
    120_000,
  );
});
