// PERMANENT GUARD: only `api` carries a database credential — issue #1026 W4.
//
// AUTHORITY: docs/technical/system-scheduler-spec.md §1, §7, §9 and §10.
//
//   §1: the API is "the only running service in this document's scope" that
//    holds a database connection. `system-scheduler`: "**No.** Never."
//
//   §9: "Among the running services this document covers, only the API connects
//    to the database. (The analytics and research workers are outside this
//    document; their move to the same model is a later document, and until then
//    they keep the credentials they have. This invariant is not silently
//    extended to them.)"
//
//   §10: "No service other than `api` carries a database credential in any
//    composition in this document's scope, asserted by rendering the compose
//    config."
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS REPLACES
// ─────────────────────────────────────────────────────────────────────────────
//
// `worker-swarm` held a database credential AND a model key, and ran the
// consensus judge on a cron. Both are gone: the clock is `system-scheduler`,
// which holds one API token, and the judge is a participant container holding
// its own model key. This file is what stops either coming back — not as a
// one-off check at the end of the removal, but permanently.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE EXCEPTION LIST IS NAMED, AND WHY IT IS SHORT
// ─────────────────────────────────────────────────────────────────────────────
//
// §9 carves out the analytics and research workers explicitly, and adds "This
// invariant is not silently extended to them." A test with a wildcard for
// `worker-*` would be that silent extension: a new worker lane would inherit
// the exception without anyone deciding to grant it. So each exempt service is
// named, with its reason, and `EXEMPT` is asserted to contain nothing that is
// not in the rendered configuration — a stale exemption is itself a finding.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE DECLARATION IS THE FINDING, NOT THE VALUE
// ─────────────────────────────────────────────────────────────────────────────
//
// `docker compose config --env-file /dev/null` resolves `${DATABASE_URL}` to
// the empty string, so a rendered value proves nothing about production. What
// the rendering DOES show is which services the compose files hand the variable
// to at all — through an anchor, an `x-` extension, an overlay or directly —
// and that is the credential boundary. An empty value today is a populated one
// on the host that sets it.
//
// Docker is a hard dependency of this repo's test harness. A missing docker CLI
// fails the rendered cases loudly rather than skipping, per the test-coverage
// policy; the detector is a pure function, so its own cases and the red control
// still run and still prove it works.
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const repoRoot = join(import.meta.dir, "../../..");

export interface ComposeServiceLike {
  environment?: Record<string, string | null> | string[];
  env_file?: string | string[];
}

export interface ComposeConfigLike {
  services?: Record<string, ComposeServiceLike | undefined>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The detector
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Environment names that hand a service a client credential for the database.
 *
 * `POSTGRES_PASSWORD` is NOT here. It is the server's own initialization
 * variable on the `postgres` service — the database setting its own password,
 * not a client being given one — and listing it would make the one service that
 * legitimately owns the secret the loudest finding in the file.
 */
export const DB_CREDENTIAL_KEYS = [
  "DATABASE_URL",
  "WORKER_DATABASE_URL",
  "PREFLIGHT_DATABASE_URL",
  "PGPASSWORD",
  "PGUSER",
  "PGPASSFILE",
  "RM_APP_PASSWORD",
  "RM_WORKER_PASSWORD",
  "RM_OWNER_PASSWORD",
  "RM_READONLY_PASSWORD",
] as const;

/** A value that is a Postgres connection string, whatever the key is called. */
export function looksLikeConnectionString(value: unknown): boolean {
  return typeof value === "string" && /^postgres(ql)?:\/\//i.test(value.trim());
}

export interface CredentialFinding {
  service: string;
  key: string;
  reason: "declared_credential_key" | "connection_string_value";
}

function normaliseEnvironment(env: ComposeServiceLike["environment"]): Record<string, string | null> {
  if (!env) return {};
  if (Array.isArray(env)) {
    const out: Record<string, string | null> = {};
    for (const entry of env) {
      const eq = entry.indexOf("=");
      if (eq === -1) out[entry] = null;
      else out[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    return out;
  }
  return env;
}

/**
 * Every service in a parsed configuration that is handed a database credential.
 *
 * Pure: no Docker, no I/O. That is what lets the fixture cases below prove the
 * detector works even where Docker cannot be reached, and what lets the red
 * control plant a violation without touching a tracked file.
 */
export function findDatabaseCredentials(cfg: ComposeConfigLike): CredentialFinding[] {
  const out: CredentialFinding[] = [];
  for (const [service, def] of Object.entries(cfg.services ?? {})) {
    const env = normaliseEnvironment(def?.environment);
    for (const [key, value] of Object.entries(env)) {
      if ((DB_CREDENTIAL_KEYS as readonly string[]).includes(key)) {
        out.push({ service, key, reason: "declared_credential_key" });
        continue;
      }
      if (looksLikeConnectionString(value)) {
        out.push({ service, key, reason: "connection_string_value" });
      }
    }
  }
  return out.sort((a, b) => `${a.service}${a.key}`.localeCompare(`${b.service}${b.key}`));
}

/**
 * The services allowed to hold one, each with the clause that allows it.
 *
 * Nothing else may be added here without amending §9, which is the point of
 * spelling the reason out beside the name.
 */
export const EXEMPT: Record<string, string> = {
  api: "§1: the API is the only service in scope that holds a database connection",
  "worker-analytics": "§9's named exception: outside this document, keeps its credential until a later one",
  "worker-research": "§9's named exception: outside this document, keeps its credential until a later one",
  migrate: "a one-shot migration runner, not a running service; it exists to hold rm_owner for one command",
};

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "COMPOSE_FILE" || k === "COMPOSE_PROJECT_NAME") continue;
    env[k] = v;
  }
  env.SMOKE_PROJECT = "no-db-credential-test";
  env.RM_STACK_ENV_CLASS = "local";
  env.RM_STACK_ENV_HASH = "nodbcred000";
  env.WEB_PORT = "18788";
  env.POSTGRES_PORT = "15433";
  return env;
}

const BASE = ["docker-compose.yml"] as const;

interface Composition {
  label: string;
  files: readonly string[];
  profiles: readonly string[];
}

/** Every composition this repo boots that exists at the time of writing. */
const COMPOSITIONS: readonly Composition[] = [
  { label: "base (docker-compose.yml)", files: BASE, profiles: [] },
  { label: "base [profile member-agent]", files: BASE, profiles: ["member-agent"] },
];

function renderCompose(files: readonly string[], profiles: readonly string[]): string {
  const r = Bun.spawnSync(
    [
      "docker", "compose", "--env-file", "/dev/null",
      ...profiles.flatMap((p) => ["--profile", p]),
      ...files.flatMap((f) => ["-f", f]),
      "config", "--format", "json",
    ],
    { cwd: repoRoot, env: baseEnv(), stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `docker compose config failed (exit ${r.exitCode}) for [${files.join(" ")}]: ` +
        new TextDecoder().decode(r.stderr),
    );
  }
  return new TextDecoder().decode(r.stdout);
}

const renderCache = new Map<string, string>();

function composeConfig(files: readonly string[], profiles: readonly string[]): ComposeConfigLike {
  const key = JSON.stringify({ files: [...files], profiles: [...profiles] });
  let json = renderCache.get(key);
  if (json === undefined) {
    json = renderCompose(files, profiles);
    renderCache.set(key, json);
  }
  return JSON.parse(json) as ComposeConfigLike;
}

beforeAll(() => {
  // One render per argument set, ahead of the bodies, so no test waits on Docker.
  for (const { files, profiles } of COMPOSITIONS) composeConfig(files, profiles);
});

// ─────────────────────────────────────────────────────────────────────────────
// The rendered assertions
// ─────────────────────────────────────────────────────────────────────────────

describe("only the named services carry a database credential (§9, §10)", () => {
  for (const { label, files, profiles } of COMPOSITIONS) {
    test(`${label}: every finding is a named exception`, () => {
      const findings = findDatabaseCredentials(composeConfig(files, profiles));
      const unexpected = findings.filter((f) => !(f.service in EXEMPT));
      expect(
        unexpected.map((f) => `${f.service} carries ${f.key} (${f.reason})`),
      ).toEqual([]);
    });
  }

  test("`system-scheduler` exists and carries NO database credential of any kind", () => {
    const cfg = composeConfig(BASE, []);
    const service = cfg.services?.["system-scheduler"];
    expect({ present: service !== undefined }).toEqual({ present: true });
    const findings = findDatabaseCredentials({ services: { "system-scheduler": service } });
    expect(findings).toEqual([]);
  });

  test("`system-scheduler` carries its API token as a FILE path and nothing else secret (§7, smoke §3)", () => {
    const env = normaliseEnvironment(composeConfig(BASE, []).services?.["system-scheduler"]?.environment);
    expect(Object.keys(env)).toContain("SCHEDULER_TOKEN_FILE");
    // §7: "It signs nothing … It calls no model … It holds no Docker socket."
    for (const forbidden of ["OPENCODE_API_KEY", "RM_CREDENTIALS", "RM_MEMBER_TOKEN", "ADMIN_TOKEN"]) {
      expect({ forbidden, present: forbidden in env }).toEqual({ forbidden, present: false });
    }
  });

  test("no `worker-swarm` service exists in any composition", () => {
    for (const { label, files, profiles } of COMPOSITIONS) {
      const names = Object.keys(composeConfig(files, profiles).services ?? {});
      expect({ label, hasWorkerSwarm: names.includes("worker-swarm") }).toEqual({
        label,
        hasWorkerSwarm: false,
      });
    }
  });

  test("every exemption is still a real service — a stale exemption is itself a finding", () => {
    const names = new Set<string>();
    for (const { files, profiles } of COMPOSITIONS) {
      for (const n of Object.keys(composeConfig(files, profiles).services ?? {})) names.add(n);
    }
    const stale = Object.keys(EXEMPT).filter((s) => !names.has(s));
    // `migrate` may legitimately not exist as a compose service; it is listed
    // so that if one is ever added it is already reasoned about. Every other
    // exemption must correspond to something real.
    expect(stale.filter((s) => s !== "migrate")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The detector's own cases
// ─────────────────────────────────────────────────────────────────────────────

describe("the detector", () => {
  test("finds a declared DATABASE_URL even when it renders empty", () => {
    expect(
      findDatabaseCredentials({ services: { clock: { environment: { DATABASE_URL: "" } } } }),
    ).toEqual([{ service: "clock", key: "DATABASE_URL", reason: "declared_credential_key" }]);
  });

  test("finds a connection string hiding under an innocent key name", () => {
    expect(
      findDatabaseCredentials({
        services: { clock: { environment: { RM_BACKUP_TARGET: "postgresql://u:p@h/db" } } },
      }),
    ).toEqual([{ service: "clock", key: "RM_BACKUP_TARGET", reason: "connection_string_value" }]);
  });

  test("reads the list form of `environment` as well as the map form", () => {
    expect(
      findDatabaseCredentials({ services: { clock: { environment: ["DATABASE_URL=postgres://x"] } } }),
    ).toHaveLength(1);
  });

  test("does not flag the database's own POSTGRES_PASSWORD", () => {
    expect(
      findDatabaseCredentials({ services: { postgres: { environment: { POSTGRES_PASSWORD: "x" } } } }),
    ).toEqual([]);
  });

  test("does not flag an API URL", () => {
    expect(
      findDatabaseCredentials({
        services: { "system-scheduler": { environment: { SCHEDULER_API_URL: "http://api:3000" } } },
      }),
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The red control
// ─────────────────────────────────────────────────────────────────────────────

describe("RED CONTROL: a planted credential is caught end to end", () => {
  test("an overlay handing `system-scheduler` a DATABASE_URL is found in the rendered config", () => {
    // Written to a temp dir, never into a tracked compose file, and rendered
    // through the SAME `docker compose config` path the real cases use. A guard
    // that has never been seen to fail is a guard nobody should trust.
    const dir = mkdtempSync(join(tmpdir(), "rm-dbcred-"));
    const overlay = join(dir, "docker-compose.planted.yml");
    writeFileSync(
      overlay,
      "services:\n  system-scheduler:\n    environment:\n      DATABASE_URL: postgres://planted@postgres/rm\n",
      "utf8",
    );
    const cfg = JSON.parse(renderCompose([...BASE, overlay], [])) as ComposeConfigLike;
    const findings = findDatabaseCredentials(cfg).filter((f) => f.service === "system-scheduler");
    expect(findings.map((f) => f.key)).toContain("DATABASE_URL");
  });

  test("and the unplanted render is clean, so the control proves the plant and not the path", () => {
    const findings = findDatabaseCredentials(composeConfig(BASE, [])).filter(
      (f) => f.service === "system-scheduler",
    );
    expect(findings).toEqual([]);
  });
});
