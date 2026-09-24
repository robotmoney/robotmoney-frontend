// PERMANENT GUARD: no service in any composition may hold the Docker socket.
//
// Issue #1014 (a9f2008b) added an `agent-launcher` compose service that bind
// mounted `/var/run/docker.sock` so it could start a short-lived judge
// container, and shipped a test asserting EXACTLY ONE service carried that
// mount. That commit has been reverted wholesale — launcher, Dockerfile and
// test are gone — and this file is the INVERSE assertion, kept permanently.
//
// Why it is permanent and not transitional:
//
//   - docs/technical/smoke-production-spec.md §6.2, the adopted design: "No
//     participant container holds a database credential or a Docker socket."
//   - The secret-management direction forbids `docker.sock` in any container,
//     full stop (in-RAM leases, revoke-on-die, USER 1001, no docker.sock).
//   - The socket IS root on the host. There is no read-only mode for it and no
//     capability that makes it safe: `-v /var/run/docker.sock:...:ro` still
//     lets the holder run a privileged container that mounts `/`. A service
//     holding it puts root behind every request handler and every piece of
//     model-derived text that process touches.
//
// The assertion is made against the RENDERED configuration (`docker compose
// … config --format json`), never against the raw YAML text. A mount can
// arrive through a YAML anchor, an `x-` extension field merged into a service,
// or an overlay file, and only the rendered output shows what Docker would
// really do.
//
// Docker is a hard dependency of this repo's test harness (the backend suite
// boots ephemeral Postgres through it); a missing docker CLI fails the
// rendered cases loudly — never a silent skip (test-coverage policy). The
// detector itself is a pure function over a parsed config, so the fixture
// cases and the RED CONTROL's pure-function half still run and still prove the
// detector works even where Docker cannot be reached.
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const repoRoot = join(import.meta.dir, "../../..");

// ---------------------------------------------------------------------------
// The parsed-config shape this file reads. Deliberately wider than the compose
// schema: `volumes` entries are typed as the union compose accepts (short
// string syntax and long object syntax) because the detector must survive
// BOTH, and an unknown-shaped entry must be inspected rather than skipped.
export type ComposeVolumeEntry =
  | string
  | {
      type?: string;
      source?: string;
      target?: string;
      read_only?: boolean;
    };

export interface ComposeServiceLike {
  volumes?: ComposeVolumeEntry[];
  environment?: Record<string, string | null> | string[];
}

export interface ComposeConfigLike {
  services?: Record<string, ComposeServiceLike | undefined>;
}

/** One place a Docker socket reached a container. */
export interface SocketFinding {
  /** Compose service name, e.g. "api". */
  service: string;
  /** Which field carried it, e.g. "volumes[0].source". */
  where: string;
  /** The offending value, verbatim. */
  value: string;
  /** Human-readable reason, used in the failure message. */
  reason: string;
}

// A path is the Docker socket if any segment of it is `docker.sock`. This
// catches every spelling the daemon actually honours:
//   /var/run/docker.sock   — the canonical path
//   /run/docker.sock       — the same inode on systemd hosts, /var/run is a symlink
//   //var/run/docker.sock  — compose's own normalisation of a Windows-ish path
//   /var/run/docker.sock/  — a trailing slash
// and it deliberately also catches a socket relocated elsewhere on the host
// (e.g. ~/.docker/desktop/docker.sock, /var/run/docker.sock.raw is NOT caught
// by the segment rule, so the substring rule below covers renamed copies too).
const SOCKET_SEGMENT = /(^|\/)docker\.sock($|\/)/;

export function isDockerSocketPath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v === "") return false;
  if (SOCKET_SEGMENT.test(v)) return true;
  // Renamed or suffixed copies of the same socket (docker.sock.raw is what
  // Docker Desktop actually exposes on macOS, and a rootless install may sit at
  // …/docker.sock-1000). Still root over the daemon, so still forbidden.
  return /docker\.sock[^/]*$/.test(v);
}

// A DOCKER_HOST that points at a unix socket (or a Windows named pipe) is the
// same authority as the bind mount, delivered through the environment instead
// of through `volumes`. A tcp:// DOCKER_HOST is out of scope for THIS guard:
// it is not a socket mount, it is a network reachability question, and the
// smoke spec covers it separately.
export function isDockerSocketEndpoint(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v === "") return false;
  if (/^unix:\/\//i.test(v) || /^npipe:\/\//i.test(v) || /^fd:\/\//i.test(v)) return true;
  // A bare path, which the docker CLI also accepts for DOCKER_HOST.
  return v.startsWith("/") && isDockerSocketPath(v);
}

function normaliseEnvironment(
  env: ComposeServiceLike["environment"],
): Array<[string, string | null]> {
  if (!env) return [];
  if (Array.isArray(env)) {
    // List syntax: "KEY=value" or bare "KEY" (inherit from the host).
    return env.map((entry): [string, string | null] => {
      const eq = entry.indexOf("=");
      return eq === -1 ? [entry, null] : [entry.slice(0, eq), entry.slice(eq + 1)];
    });
  }
  return Object.entries(env);
}

/**
 * THE DETECTOR. Pure over a parsed compose configuration — no Docker, no I/O,
 * no process.env — so it is directly testable against fixtures and is the same
 * code path the rendered cases use.
 *
 * Returns every place a Docker socket reaches a container, across every
 * service. An empty array is the only acceptable result for this repo.
 */
export function findDockerSocketMounts(cfg: ComposeConfigLike): SocketFinding[] {
  const findings: SocketFinding[] = [];
  for (const [service, svc] of Object.entries(cfg.services ?? {})) {
    if (!svc) continue;

    for (const [index, entry] of (svc.volumes ?? []).entries()) {
      if (typeof entry === "string") {
        // Short syntax: "SOURCE:TARGET[:MODE]". Check every colon-separated
        // field rather than only field 0 — a mount is forbidden whether the
        // socket is the host source or the in-container target.
        for (const [field, part] of entry.split(":").entries()) {
          if (!isDockerSocketPath(part)) continue;
          findings.push({
            service,
            where: `volumes[${index}] (short syntax, field ${field})`,
            value: entry,
            reason: "bind mount of the Docker socket",
          });
          break;
        }
        continue;
      }
      if (isDockerSocketPath(entry.source)) {
        findings.push({
          service,
          where: `volumes[${index}].source`,
          value: String(entry.source),
          reason: `${entry.type ?? "bind"} mount whose host source is the Docker socket`,
        });
      }
      if (isDockerSocketPath(entry.target)) {
        findings.push({
          service,
          where: `volumes[${index}].target`,
          value: String(entry.target),
          reason: "mount landing on the Docker socket path inside the container",
        });
      }
    }

    for (const [key, value] of normaliseEnvironment(svc.environment)) {
      const isSocketKey = key === "DOCKER_HOST" || key === "DOCKER_SOCKET";
      if (isSocketKey && isDockerSocketEndpoint(value)) {
        findings.push({
          service,
          where: `environment.${key}`,
          value: String(value),
          reason: "environment variable pointing the Docker client at a socket",
        });
        continue;
      }
      // Any other key whose VALUE is a socket path is equally damning — the
      // point is the authority, not the variable's name.
      if (!isSocketKey && isDockerSocketPath(value)) {
        findings.push({
          service,
          where: `environment.${key}`,
          value: String(value),
          reason: "environment variable carrying the Docker socket path",
        });
      }
    }
  }
  return findings;
}

/** The failure message: NAMES the composition and every offending service. */
export function describeFindings(composition: string, findings: SocketFinding[]): string {
  if (findings.length === 0) return `${composition}: no Docker socket`;
  const lines = findings.map(
    (f) => `  service "${f.service}" -> ${f.where} = ${f.value}  (${f.reason})`,
  );
  return [
    `${composition}: ${findings.length} Docker socket reference(s) — FORBIDDEN.`,
    ...lines,
    "The Docker socket is root on the host. There is no read-only mode and no",
    "capability that makes it safe (see docs/technical/smoke-production-spec.md",
    "§6.2). Remove the mount; do not relax this test.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// RENDERING. A thin wrapper around the detector, with ONE `docker compose
// config` run per distinct argument set (issue #809) so no test body ever waits
// on Docker — the same discipline scripts/tests/integration/
// smoke-compose-config.test.ts follows and for the same reason.

// Inherit the caller's env (PATH/HOME/DOCKER_*) but supply the `${VAR:?…}`
// variables docker-compose.yml requires — `config` refuses to resolve without
// them — and the label inputs the smoke overlay stamps, so the render emits no
// interpolation warnings. The values are arbitrary; nothing is published.
function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (k === "COMPOSE_FILE" || k === "COMPOSE_PROJECT_NAME") continue;
    env[k] = v;
  }
  env.SMOKE_PROJECT = "no-docker-socket-test";
  env.RM_STACK_ENV_CLASS = "local";
  env.RM_STACK_ENV_HASH = "nosocket000";
  env.WEB_PORT = "18787";
  env.POSTGRES_PORT = "15432";
  return env;
}

const BASE = ["docker-compose.yml"] as const;
const SMOKE = ["docker-compose.yml", "docker-compose.smoke.yml"] as const;
const STAGE = ["docker-compose.yml", "docker-compose.smoke.yml", "docker-compose.stage.yml"] as const;

interface Composition {
  /** Named in every failure message. */
  label: string;
  files: readonly string[];
  profiles: readonly string[];
}

// Every composition this repo actually boots. `member-agent` is profile-gated
// in docker-compose.smoke.yml (never started by a bare `docker compose up`), so
// it is invisible to a default render and needs its own entry — a socket mount
// hiding behind a profile is exactly the regression this file exists to catch.
const COMPOSITIONS: readonly Composition[] = [
  { label: "base (docker-compose.yml)", files: BASE, profiles: [] },
  { label: "base + smoke", files: SMOKE, profiles: [] },
  { label: "base + smoke + stage", files: STAGE, profiles: [] },
  { label: "base + smoke [profile member-agent]", files: SMOKE, profiles: ["member-agent"] },
  { label: "base + smoke + stage [profile member-agent]", files: STAGE, profiles: ["member-agent"] },
];

function renderCompose(files: readonly string[], profiles: readonly string[]): string {
  const r = Bun.spawnSync(
    [
      // `--env-file /dev/null` is what the stack's own composeArgs() passes, so
      // this dump is the config a real boot gets — not one coloured by whatever
      // `.env` the checkout this suite runs in happens to carry.
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

// Memoised on the FULL argument set (files + profiles). The cache holds raw
// JSON TEXT and re-parses per call, so no case can leak a mutation into a
// sibling.
const renderCache = new Map<string, string>();
let prewarmed = false;
/** Renders that missed the prewarm — see the regression guard at end of file. */
const coldRendersAfterPrewarm: string[] = [];

function composeConfig(files: readonly string[], profiles: readonly string[]): ComposeConfigLike {
  const key = JSON.stringify({ files: [...files], profiles: [...profiles] });
  let json = renderCache.get(key);
  if (json === undefined) {
    if (prewarmed) coldRendersAfterPrewarm.push(key);
    json = renderCompose(files, profiles);
    renderCache.set(key, json);
  }
  return JSON.parse(json) as ComposeConfigLike;
}

// Sized against a degraded shared runner, not this workstation: a cold Docker
// CLI start-up on `ubuntu-latest` measured ~5.2 s plus ~0.13 s per render, so
// these five renders cost roughly 6 s there. 300 s is ~50x that and costs
// nothing unless a render actually hangs, while still failing loudly in five
// minutes instead of running out the job. Bun's default beforeAll budget is
// 5000 ms — dropping this argument would put the prewarm back under the very
// budget that made PR #801's `unit` job flake.
const PREWARM_TIMEOUT_MS = 300_000;

beforeAll(() => {
  for (const { files, profiles } of COMPOSITIONS) composeConfig(files, profiles);
  prewarmed = true;
}, PREWARM_TIMEOUT_MS);

// ---------------------------------------------------------------------------
describe("no service in any composition holds the Docker socket", () => {
  for (const { label, files, profiles } of COMPOSITIONS) {
    test(`${label}: ZERO services mount /var/run/docker.sock`, () => {
      const cfg = composeConfig(files, profiles);

      // Guard the guard: an empty render would make the assertion below pass
      // vacuously, which is the classic way a negative test rots into a no-op.
      const serviceNames = Object.keys(cfg.services ?? {});
      expect(serviceNames.length).toBeGreaterThan(0);

      const findings = findDockerSocketMounts(cfg);
      expect(describeFindings(label, findings)).toBe(`${label}: no Docker socket`);
      expect(findings).toEqual([]);
    });
  }

  test("the member-agent profile really does add a service (the profile renders are not duplicates)", () => {
    const withoutProfile = Object.keys(composeConfig(SMOKE, []).services ?? {});
    const withProfile = Object.keys(composeConfig(SMOKE, ["member-agent"]).services ?? {});
    expect(withProfile.length).toBeGreaterThan(withoutProfile.length);
  });

  test("no composition contains an agent-launcher service at all (issue #1014 stays reverted)", () => {
    for (const { label, files, profiles } of COMPOSITIONS) {
      const names = Object.keys(composeConfig(files, profiles).services ?? {});
      expect(`${label}:${names.includes("agent-launcher")}`).toBe(`${label}:false`);
    }
  });
});

// ---------------------------------------------------------------------------
// THE DETECTOR'S OWN TESTS. Pure, no Docker: these run and pass anywhere, so
// the guard can always be shown to have teeth even where the daemon is absent.
describe("detector catches every spelling of the socket", () => {
  const fixtures: ReadonlyArray<{ name: string; cfg: ComposeConfigLike; service: string }> = [
    {
      name: "long syntax bind, canonical path",
      service: "launcher",
      cfg: {
        services: {
          launcher: {
            volumes: [
              { type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" },
            ],
          },
        },
      },
    },
    {
      name: "long syntax bind, systemd /run path",
      service: "launcher",
      cfg: {
        services: {
          launcher: { volumes: [{ type: "bind", source: "/run/docker.sock", target: "/sock" }] },
        },
      },
    },
    {
      name: "short syntax string",
      service: "api",
      cfg: { services: { api: { volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"] } } },
    },
    {
      name: "short syntax, socket only as the in-container TARGET",
      service: "api",
      cfg: { services: { api: { volumes: ["/tmp/proxy.sock:/var/run/docker.sock"] } } },
    },
    {
      name: "compose's double-slash normalisation",
      service: "system-scheduler",
      cfg: { services: { "system-scheduler": { volumes: ["//var/run/docker.sock:/x"] } } },
    },
    {
      name: "renamed socket (Docker Desktop's docker.sock.raw)",
      service: "system-scheduler",
      cfg: {
        services: {
          "system-scheduler": { volumes: [{ source: "/var/run/docker.sock.raw", target: "/x" }] },
        },
      },
    },
    {
      name: "DOCKER_HOST unix endpoint, map syntax",
      service: "judge",
      cfg: { services: { judge: { environment: { DOCKER_HOST: "unix:///var/run/docker.sock" } } } },
    },
    {
      name: "DOCKER_HOST unix endpoint, list syntax",
      service: "judge",
      cfg: { services: { judge: { environment: ["DOCKER_HOST=unix:///run/docker.sock"] } } },
    },
    {
      name: "DOCKER_SOCKET bare path",
      service: "judge",
      cfg: { services: { judge: { environment: { DOCKER_SOCKET: "/var/run/docker.sock" } } } },
    },
    {
      name: "socket path smuggled under an innocent variable name",
      service: "judge",
      cfg: { services: { judge: { environment: { EXTRA_MOUNT: "/var/run/docker.sock" } } } },
    },
  ];

  for (const { name, cfg, service } of fixtures) {
    test(`reports: ${name}`, () => {
      const findings = findDockerSocketMounts(cfg);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings.map((f) => f.service)).toContain(service);
      // The message names the service and the composition, so whoever trips it
      // knows immediately what to look at.
      const message = describeFindings("fixture composition", findings);
      expect(message).toContain(`service "${service}"`);
      expect(message).toContain("fixture composition");
    });
  }

  test("does NOT report the mounts this repo legitimately has", () => {
    expect(
      findDockerSocketMounts({
        services: {
          api: {
            volumes: [{ type: "bind", source: "/repo/_static", target: "/srv/frontend", read_only: true }],
            environment: { DATABASE_URL: "postgres://x", NODE_ENV: "production" },
          },
          postgres: { volumes: [{ type: "volume", source: "pgdata", target: "/var/lib/postgresql/data" }] },
          worker: { volumes: [], environment: [] },
          // A tcp:// DOCKER_HOST is explicitly out of scope for this guard:
          // it is not a socket mount. (onboarding-eval-infra.test.ts sets one
          // on a HOST process for an unreachable-daemon case.)
          tools: { environment: { DOCKER_HOST: "tcp://127.0.0.1:1" } },
          empty: {},
        },
      }),
    ).toEqual([]);
  });

  test("a config with no services reports nothing (and the rendered cases guard against that being vacuous)", () => {
    expect(findDockerSocketMounts({})).toEqual([]);
    expect(findDockerSocketMounts({ services: {} })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RED CONTROL. A guard that cannot be shown to fail is not a guard.
//
// This plants a socket mount in a TEMPORARY overlay written outside the repo
// (never into a tracked compose file), renders it through the SAME
// `docker compose config` path the real cases use, and asserts the detector
// reports it. If this test ever goes green-by-silence — findings empty — the
// guard above is asserting nothing and the whole file is worthless.
describe("red control: the detector catches a planted mount through a real render", () => {
  const PLANTED_OVERLAY = [
    "services:",
    "  api:",
    "    volumes:",
    "      - /var/run/docker.sock:/var/run/docker.sock",
    "  system-scheduler:",
    "    environment:",
    "      DOCKER_HOST: unix:///run/docker.sock",
    "",
  ].join("\n");

  test("planting a socket mount in an overlay makes the detector report it", () => {
    // Written to a temp dir, NOT the repo. `docker compose` resolves relative
    // paths against the FIRST -f file's directory, so the repo stays the
    // project directory and the base files render exactly as they normally do.
    const dir = mkdtempSync(join(tmpdir(), "rm-no-docker-socket-control-"));
    const overlay = join(dir, "docker-compose.planted.yml");
    writeFileSync(overlay, PLANTED_OVERLAY);

    const json = renderCompose([...SMOKE, overlay], []);
    const cfg = JSON.parse(json) as ComposeConfigLike;

    const findings = findDockerSocketMounts(cfg);
    expect(findings.length).toBeGreaterThan(0);
    // `api` yields two findings (host source AND in-container target), so
    // compare the distinct set of offending services.
    expect([...new Set(findings.map((f) => f.service))].sort()).toEqual(["api", "system-scheduler"]);

    const message = describeFindings("base + smoke + PLANTED overlay", findings);
    expect(message).toContain('service "api"');
    expect(message).toContain('service "system-scheduler"');
    expect(message).toContain("base + smoke + PLANTED overlay");

    // And the real thing stays clean — the plant did not come from the repo.
    expect(findDockerSocketMounts(composeConfig(SMOKE, []))).toEqual([]);
  }, 120_000);

  test("the same plant is caught with no Docker at all (pure-function half of the control)", () => {
    // Exactly what `docker compose config` emits for the overlay above, so this
    // half of the control holds even where the daemon is unreachable.
    const rendered: ComposeConfigLike = {
      services: {
        api: {
          volumes: [
            { type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" },
          ],
        },
        "system-scheduler": { environment: { DOCKER_HOST: "unix:///run/docker.sock" } },
      },
    };
    const findings = findDockerSocketMounts(rendered);
    expect(findings.map((f) => f.service).sort()).toEqual(["api", "api", "system-scheduler"]);
    expect(describeFindings("planted", findings)).not.toBe("planted: no Docker socket");
  });
});

// ---------------------------------------------------------------------------
// Issue #809's regression guard, declared last so every case above has run.
// A case that asks for a rendering the prewarm does not cover shells out to
// Docker inside its own 5000 ms budget, which is the flake that discipline
// exists to remove. (The red control renders its own one-off composition on
// purpose and carries an explicit budget, so it uses `renderCompose` directly
// and never touches this cache.)
describe("compose renders stay hoisted out of the case bodies (issue #809)", () => {
  test("no case shelled out to Docker on its own — every rendering was prewarmed", () => {
    expect(coldRendersAfterPrewarm).toEqual([]);
  });
});
