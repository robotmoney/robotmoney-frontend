// The `csvb-backup` service's structure, as rendered (issue 1608, D82): the scheduled archive backup.
//
// It is the one named exception to D75, so what it may hold is pinned tightly here: no Docker socket, no database
// URL or connection key, a memory ceiling, an init, ONE credential mount that is read-only and carries only
// replica.env and push-key, and an image that copies only packages/csvb and packages/analyst-sdk (D80 item 1: the
// data repo holds data only, and nothing from it is ever in the image).
//
// The rendered cases need Docker's compose CLI; a missing CLI fails them loudly (test-coverage policy), never skips.
// The checks are pure functions, so the red controls plant violations without touching a tracked file.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { looksLikeConnectionString } from "../../lib/db-credential-keys.ts";
import { DB_WRITER_SERVICES } from "../../lib/smoke-failure.ts";
import { buildServicesFor, FULL_SERVICES, servicesFor } from "../../stack/config.ts";
import { ROLLING_ORDER, rollingReplaceOrder } from "../../stack/stack.ts";

const repoRoot = join(import.meta.dir, "../../..");

interface Mount {
  type?: string;
  source?: string;
  target?: string;
  read_only?: boolean;
}
interface Svc {
  environment?: Record<string, string | null>;
  volumes?: Mount[];
  mem_limit?: string | number;
  init?: boolean;
  stop_grace_period?: string;
  healthcheck?: { test?: string[] };
  cpus?: number | string;
  depends_on?: Record<string, unknown> | string[];
  restart?: string;
  build?: { context?: string; dockerfile?: string };
}

const STATE_DIR = "/home/test/rm-instance-state/rm_local_csvb";

function render(): Record<string, Svc> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== "COMPOSE_FILE" && k !== "COMPOSE_PROJECT_NAME") env[k] = v;
  Object.assign(env, { RM_INSTANCE: "rm_local_csvb", RM_INSTANCE_STATE_DIR: STATE_DIR, SMOKE_PROJECT: "csvb-backup-test", WEB_PORT: "18789", POSTGRES_PORT: "15434" });
  const r = Bun.spawnSync(["docker", "compose", "--env-file", "/dev/null", "-f", "docker-compose.yml", "config", "--format", "json"], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`docker compose config failed (exit ${r.exitCode}): ${new TextDecoder().decode(r.stderr)}`);
  return (JSON.parse(new TextDecoder().decode(r.stdout)) as { services: Record<string, Svc> }).services;
}

/** Every way the service may not look. Pure. */
export function problemsOf(svc: Svc): string[] {
  const out: string[] = [];
  for (const v of svc.volumes ?? []) {
    if (/docker\.sock/.test(`${v.source ?? ""} ${v.target ?? ""}`)) out.push(`mounts the Docker socket (${v.source} -> ${v.target})`);
  }
  for (const [k, value] of Object.entries(svc.environment ?? {})) {
    if (k === "DATABASE_URL" || k === "WORKER_DATABASE_URL") out.push(`declares ${k}`);
    if (/^PG/.test(k)) out.push(`declares the connection key ${k}`);
    if (looksLikeConnectionString(value ?? undefined)) out.push(`${k} holds a connection string`);
  }
  if (svc.mem_limit === undefined) out.push("has no mem_limit");
  if (svc.init !== true) out.push("does not run under an init");
  if (svc.stop_grace_period === undefined) out.push("has no stop_grace_period");
  if (svc.cpus === undefined) out.push("has no cpus cap");
  if (svc.restart !== "unless-stopped") out.push(`restart policy is ${svc.restart}, expected unless-stopped`);
  if (svc.depends_on !== undefined && Object.keys(svc.depends_on).length > 0) out.push("depends on another service: it must start and idle without the api");
  if (svc.healthcheck?.test === undefined) out.push("has no healthcheck");
  const binds = (svc.volumes ?? []).filter((v) => v.type === "bind");
  if (binds.length !== 1) out.push(`has ${binds.length} bind mounts, expected exactly one credential mount`);
  for (const b of binds) {
    if (b.read_only !== true) out.push(`credential mount ${b.target} is not read-only`);
    if (b.target !== "/run/csvb-credentials") out.push(`credential mount target is ${b.target}`);
    if (basename(b.source ?? "") !== "csvb-backup") out.push(`credential mount source ${b.source} is not the csvb-backup directory`);
  }
  // The only files its environment names inside that directory: replica.env and push-key.
  const files = Object.entries(svc.environment ?? {})
    .filter(([, value]) => (value ?? "").startsWith("/run/csvb-credentials/"))
    .map(([, value]) => basename(value!))
    .sort();
  if (files.join(",") !== "push-key,replica.env") out.push(`names the credential files ${files.join(", ")}, expected push-key and replica.env`);
  return out;
}

/** The sources a Dockerfile COPYs from the build context. Pure. */
export function copySources(dockerfile: string): string[] {
  const out: string[] = [];
  for (const raw of dockerfile.split("\n")) {
    const m = /^\s*(?:COPY|ADD)\s+(?:--\S+\s+)*(.+)$/i.exec(raw);
    if (!m) continue;
    const parts = m[1]!.trim().split(/\s+/);
    out.push(...parts.slice(0, -1));
  }
  return out;
}

const ALLOWED_COPY = /^packages\/(csvb|analyst-sdk)(\/|$)/;

const SERVICES = render();
const svc = (): Svc => {
  const s = SERVICES["csvb-backup"];
  if (!s) throw new Error("docker-compose.yml has no csvb-backup service");
  return s;
};

describe("the rendered csvb-backup service", () => {
  test("has no docker socket, no database key, a memory ceiling, an init and exactly one read-only credential mount of replica.env and push-key", () => {
    expect(problemsOf(svc())).toEqual([]);
  });

  test("its one credential mount is its own directory of the instance's state, and its clone volume holds no credential", () => {
    const vols = svc().volumes ?? [];
    expect(vols.filter((v) => v.type === "bind").map((v) => [v.source, v.target, v.read_only])).toEqual([[`${STATE_DIR}/csvb-backup`, "/run/csvb-credentials", true]]);
    expect(vols.filter((v) => v.type === "volume").map((v) => v.target)).toEqual(["/data"]);
  });

  test("it is built from packages/csvb/Dockerfile with the repo root as context", () => {
    expect(svc().build?.dockerfile).toBe("packages/csvb/Dockerfile");
    expect(svc().build?.context).toBe(repoRoot);
  });

  test("it carries no DATABASE_URL, no PG key and no connection string, and its database credential is one FILE path", () => {
    const env = svc().environment ?? {};
    expect(Object.keys(env).filter((k) => k === "DATABASE_URL" || k === "WORKER_DATABASE_URL" || /^PG/.test(k))).toEqual([]);
    expect(Object.values(env).filter((v) => looksLikeConnectionString(v ?? undefined))).toEqual([]);
    expect(env.CSVB_ENV_FILE).toBe("/run/csvb-credentials/replica.env");
    expect(env.CSVB_PUSH_KEY).toBe("/run/csvb-credentials/push-key");
  });
});

// OPTIONAL AND NON-GATING (D82): nothing waits on it and it waits on nothing.
describe("csvb-backup gates nothing", () => {
  const dependsOn = (s: Svc): string[] => (Array.isArray(s.depends_on) ? s.depends_on : Object.keys(s.depends_on ?? {}));

  test("no other service lists it in depends_on, and it lists none", () => {
    const dependents = Object.entries(SERVICES).filter(([, s]) => dependsOn(s).includes("csvb-backup")).map(([n]) => n);
    expect(dependents).toEqual([]);
    expect(dependsOn(svc())).toEqual([]);
  });

  test("it is absent from every stack service list a boot waits on or rolls", () => {
    for (const profile of ["core", "full"] as const) {
      expect(servicesFor(profile)).not.toContain("csvb-backup");
      expect(servicesFor(profile, { externalPostgres: true })).not.toContain("csvb-backup");
      expect(buildServicesFor(profile)).not.toContain("csvb-backup");
    }
    expect([...FULL_SERVICES]).not.toContain("csvb-backup");
    expect([...ROLLING_ORDER]).not.toContain("csvb-backup");
    expect([...DB_WRITER_SERVICES]).not.toContain("csvb-backup");
    expect(rollingReplaceOrder(servicesFor("full"))).not.toContain("csvb-backup");
  });

  test("no readiness, preflight or release-boot module names it", () => {
    const files = ["scripts/lib/smoke-readiness-scheduler.ts", "scripts/lib/smoke-readiness-probes.ts", "scripts/lib/smoke-failure.ts", "backend/src/db/preflight.ts"];
    for (const f of files) expect({ f, names: readFileSync(join(repoRoot, f), "utf8").includes("csvb-backup") }).toEqual({ f, names: false });
  });

  test("red control: a planted depends_on on it is caught", () => {
    const planted: Record<string, Svc> = { ...SERVICES, api: { ...SERVICES.api, depends_on: { "csvb-backup": { condition: "service_healthy" } } } };
    expect(Object.entries(planted).filter(([, s]) => dependsOn(s).includes("csvb-backup")).map(([n]) => n)).toEqual(["api"]);
    const dep = { ...svc(), depends_on: { api: { condition: "service_healthy" } } };
    expect(problemsOf(dep).some((x) => x.includes("depends on another service"))).toBe(true);
  });
});

describe("red controls", () => {
  const good = (): Svc => JSON.parse(JSON.stringify(svc())) as Svc;

  test("a docker.sock mount is reported", () => {
    const s = good();
    s.volumes = [...(s.volumes ?? []), { type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }];
    const p = problemsOf(s);
    expect(p.some((x) => x.includes("Docker socket"))).toBe(true);
    expect(p.some((x) => x.includes("2 bind mounts"))).toBe(true);
  });

  test("a second credential file or mount is reported", () => {
    const s = good();
    s.environment = { ...s.environment, CSVB_EXTRA: "/run/csvb-credentials/token" };
    expect(problemsOf(s).some((x) => x.includes("names the credential files"))).toBe(true);
    const t = good();
    t.volumes = [...(t.volumes ?? []), { type: "bind", source: `${STATE_DIR}/tokens/analytics-producer`, target: "/run/rm-token", read_only: true }];
    expect(problemsOf(t).some((x) => x.includes("2 bind mounts"))).toBe(true);
  });

  test("a writable credential mount, a database URL and a missing mem_limit are reported", () => {
    const s = good();
    s.volumes = s.volumes!.map((v) => (v.type === "bind" ? { ...v, read_only: false } : v));
    s.environment = { ...s.environment, DATABASE_URL: "", PGHOST: "x", CSVB_X: "postgres://u:p@h/d" };
    delete s.mem_limit;
    const p = problemsOf(s);
    for (const needle of ["not read-only", "DATABASE_URL", "PGHOST", "connection string", "no mem_limit"]) expect(p.some((x) => x.includes(needle))).toBe(true);
  });
});

describe("the image", () => {
  const dockerfile = readFileSync(join(repoRoot, "packages", "csvb", "Dockerfile"), "utf8");

  test("copies only packages/csvb and packages/analyst-sdk from the build context", () => {
    const sources = copySources(dockerfile);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.filter((s) => !ALLOWED_COPY.test(s))).toEqual([]);
    expect(sources.some((s) => s.startsWith("packages/csvb"))).toBe(true);
    expect(sources.some((s) => s.startsWith("packages/analyst-sdk"))).toBe(true);
  });

  test("red control: a COPY of the whole context, of backend/ or of a csv-backups path is reported", () => {
    const planted = "COPY . /app\nCOPY backend/ /app/backend/\nCOPY csv-backups/ /data/\nCOPY --chown=1:1 packages/csvb/src/ /x/\n";
    expect(copySources(planted).filter((s) => !ALLOWED_COPY.test(s))).toEqual([".", "backend/", "csv-backups/"]);
  });

  test("runs the csvb command and nothing from a data clone", () => {
    expect(dockerfile).toContain('ENTRYPOINT ["bun", "run", "src/cli.ts"]');
    const code = dockerfile.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
    expect(code).not.toMatch(/csv-backups/);
  });
});
