// Demo postgres-data lifecycle (issue: smoke persistent volumes). Two layers:
//
//   1. OFFLINE compose-config assertions (pure `docker compose config` interpolation,
//      no containers): the smoke overlay stamps the robotmoney.smoke=1 + project labels
//      on the pgdata volume, and a `--pg-data`-style bind override merges by target
//      path to REPLACE the named-volume mount (so no named volume is used in bind mode).
//
//   2. An EXECUTED proof through the operator's own commands (criterion 28): a real
//      `bun smoke --local blank`, `smoke:down`, then `bun smoke --local volume` on the
//      same instance reattaches its volume, authenticates with the saved role
//      passwords, reuses the saved service tokens and reaches readiness with the
//      data the first boot left. (It replaces a postgres-only compose up/down that
//      proved a volume survives `down` but never that an instance comes back.)
//
// Docker is a hard dependency of this repo's test harness; a missing docker CLI fails
// loudly here — never a silent skip (test-coverage policy). Every executed test
// force-cleans its own project + volume in a finally/afterAll so it can never leak.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROUTES } from "@robotmoney/contract";
import { readReceipt } from "../../lib/smoke-journal.ts";
import { readStackState, SERVICE_TOKEN_HOLDERS } from "../../lib/smoke-state.ts";
import { resolveStackEnvironment, stackProjectName } from "../../stack/naming.ts";
import {
  bootFailureReport,
  BOOT_TIMEOUT_MS,
  containerEnv,
  containerIdentity,
  harness,
  journalNow,
  runCommand,
  spawnBoot,
  teardown,
  volumeExists,
  type BootHarness,
  type RunningBoot,
} from "./smoke-boot-harness.ts";

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
    // Required by docker-compose.yml (smoke spec §1.1: the instance's state directory has no
    // checkout fallback). Only postgres runs here, and it mounts neither.
    RM_INSTANCE: "rm_local_vollifecycle",
    RM_INSTANCE_STATE_DIR: "/var/empty/rm_local_vollifecycle",
    ...extra,
  };
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
// left to be rediscovered as a flake.
//
// SIZED AGAINST A DEGRADED SHARED RUNNER, NOT THIS WORKSTATION, and against a
// real measurement of one. The two renders cost ~0.8 s locally, which is the
// wrong number to multiply.
//
// THE DATUM: GitHub Actions run 33355162238 attempt 1 (PR #801, `unit` job) —
//   gh api repos/robotmoney/robotmoney-frontend/actions/runs/33355162238/attempts/1/logs
// — ran THIS file's four offline cases at 124 / 119 / 129 / 129 ms on a degraded
// runner. They were that cheap because the Docker CLI was already warm by then;
// the same log shows the first render in the whole job costing 5186.99 ms. So
// the case this budget must survive is being the first file to touch Docker:
// ~5.2 s of cold start plus ~0.13 s for the second render, about 5.3 s. 120 s
// is ~23x that, and ~480x the warm figure.
//
// The argument must stay explicit: on the pinned bun 1.3.5 a `beforeAll` with
// no timeout expires at 5000.16 ms, which would put this prewarm right back
// under the default the four cases were just lifted out of.
//
// Still bounded, so a wedged Docker fails loudly rather than running out the
// job, and a missing or broken docker CLI throws here and turns the file RED —
// never a silent skip (test-coverage policy).
const PREWARM: ReadonlyArray<readonly [string[], Record<string, string>]> = [
  [[], composeEnv()],
  [["-f", pgDataOverrideFile], composeEnv()],
];
const PREWARM_TIMEOUT_MS = 120_000;

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
    // `system-scheduler` is in this list because it is a STANDING container
    // (issue #1026): a killed CI job must leave it attributable by label, the
    // same as every other service the reaper has to find.
    for (const svc of ["postgres", "api", "worker-analytics", "worker-research", "system-scheduler"]) {
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

// --- 2. EXECUTED proof: a real `--local blank`, `smoke:down`, `--local volume` --
//
// Criterion 28 (smoke spec §5, §10 W1 "`volume` reuse after restart"): "`--local
// blank`, `smoke:down`, then `--local volume` reattaches the volume,
// authenticates with the saved passwords, reuses the saved token, and reaches
// readiness with prior data present." Driven through the operator's own
// commands on one instance of its own. No overlay is generated for the
// reattach (it is the instance's own volume), and nothing here logs in as the
// local superuser: the prior data is written and read back through the api,
// which runs as rm_app with the instance's saved password.

let vh: BootHarness | undefined;
let vboot: RunningBoot | undefined;

afterAll(() => {
  if (vh) teardown(vh, vboot);
}, 300_000);

/** The api's host port the instance's stack record names. */
function apiUrl(h: BootHarness): string {
  const state = readStackState(h.paths);
  if (!state?.apiPort) throw new Error(`instance ${h.instance} records no api port`);
  return `http://127.0.0.1:${state.apiPort}`;
}

const tokenSnapshot = (h: BootHarness) =>
  Object.fromEntries(SERVICE_TOKEN_HOLDERS.map((holder) => [holder, readFileSync(h.paths.tokenFiles[holder], "utf8").trim()]));

describe("`--local blank`, `smoke:down`, `--local volume`: the same data, passwords and tokens (criterion 28)", () => {
  test(
    "the reattached instance authenticates with its saved passwords and token and reaches readiness with the prior data",
    async () => {
      vh = harness("vollife");
      // 1. A fresh blank instance, to readiness.
      vboot = spawnBoot(vh);
      const first = await vboot.exited;
      expect({ first, tail: first === 0 ? "" : bootFailureReport(vboot) }).toEqual({ first: 0, tail: "" });
      const passwords = readFileSync(vh.paths.rolePasswordsFile, "utf8");
      const tokens = tokenSnapshot(vh);
      const volume = readStackState(vh.paths)!.pgVolume!;

      // 2. Prior data, written THROUGH THE API as the operator (smoke spec §3:
      //    the admin right) — the api holds rm_app, never the superuser.
      const subjectId = `volprobe${Math.random().toString(16).slice(2, 8)}`;
      const created = await fetch(`${apiUrl(vh)}${ROUTES.swarm.admin.subjects}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Automation-Token": tokens.operator! },
        body: JSON.stringify({ id: subjectId, name: "Volume Probe", recommendationType: "bucket_weights", epochDuration: 3600 }),
      });
      expect({ status: created.status, body: created.ok ? "" : await created.text() }).toEqual({ status: 201, body: "" });

      // 3. smoke:down keeps the volume, the passwords and the tokens.
      const down = runCommand(vh, "smoke-down.ts", ["--instance", vh.instance]);
      expect({ code: down.code, out: down.code === 0 ? "" : down.out }).toEqual({ code: 0, out: "" });
      expect(Object.keys(containerIdentity(vh.project))).toEqual([]);
      expect(volumeExists(volume)).toBe(true);
      expect(tokenSnapshot(vh)).toEqual(tokens);

      // 4. `--local volume` on the same instance: reattach, to readiness again.
      vboot = spawnBoot(vh, [], { local: "volume" });
      const second = await vboot.exited;
      const text = vboot.output();
      expect({ second, tail: second === 0 ? "" : bootFailureReport(vboot) }).toEqual({ second: 0, tail: "" });
      expect(text).toContain(`target: local volume on volume ${volume}`);
      // The instance's OWN volume: no reattach overlay was generated.
      expect(existsSync(join(vh.paths.overlaysDir, "reattach.yml"))).toBe(false);
      // Saved passwords reused: the file is byte-for-byte the first boot's, and
      // the api authenticated with them (it answered the reads below as rm_app).
      expect(readFileSync(vh.paths.rolePasswordsFile, "utf8")).toBe(passwords);
      expect(containerEnv(vh.project, "api", "DATABASE_URL")?.includes("rm_app")).toBe(true);
      // Saved tokens reused: no `prepare (tokens)` on this plan, the files
      // unchanged, and the scheduler authenticated with its file against the
      // row the reattached volume holds.
      expect(tokenSnapshot(vh)).toEqual(tokens);
      expect((journalNow(vh)?.phases ?? []).some((r) => r.phase === "prepare" && r.step === "tokens")).toBe(false);
      const receipt = readReceipt(vh.paths)!;
      expect(receipt.plan.target).toMatchObject({ kind: "local", mode: "volume", volume });
      for (const check of receipt.readiness) expect({ check: check.check, pass: check.pass }).toEqual({ check: check.check, pass: true });
      expect(receipt.readiness.find((c) => c.check === "scheduler-authenticated")?.pass).toBe(true);
      // Prior data present, read back through the api.
      const listed = await fetch(`${apiUrl(vh)}${ROUTES.swarm.admin.subjects}`, { headers: { "X-Automation-Token": tokens.operator! } });
      expect(listed.status).toBe(200);
      const subjects = ((await listed.json()) as { subjects: { id: string }[] }).subjects.map((s) => s.id);
      expect(subjects).toContain(subjectId);
    },
    BOOT_TIMEOUT_MS * 2,
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
