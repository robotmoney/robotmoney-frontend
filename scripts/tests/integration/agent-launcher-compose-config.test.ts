// THE DOCKER SOCKET IS ON EXACTLY ONE SERVICE (issue #1012).
//
// The socket IS root on the host: there is no read-only mode for it and no
// capability to drop that makes it safe. The judge needs a container started,
// so SOMETHING in the stack must hold it — and the whole design of this change
// is that the something is one dedicated service with one internal route and
// one verb, not the long-running `api` and `worker-swarm` processes that take
// untrusted input and run model-derived text through a lot of code.
//
// That is a property of the COMPOSE FILES, and nothing in TypeScript can hold
// it: a future PR adding `- /var/run/docker.sock:/var/run/docker.sock` to the
// worker for a debugging session would be a silent privilege escalation that
// every other test in this repo would stay green through. So it is asserted
// against a REAL `docker compose config` rendering, in every composition this
// repo actually boots.
//
// Loud-skip-never (test-coverage policy): Docker is a hard dependency of this
// file, exactly as it is for its sibling smoke-compose-config.test.ts. A
// missing or unusable `docker` CLI throws out of renderComposeConfig() and
// fails every test here; nothing skips.
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_JUDGE_LAUNCHER_URL, JUDGE_LAUNCHER_PORT } from "../../../backend/src/swarm/judge-launcher.ts";
import { LAUNCHER_SERVICES, servicesFor } from "../../stack/config.ts";
import { SHIPPED_IMAGE_SERVICES } from "../../stack/images.ts";

const repoRoot = join(import.meta.dir, "../../..");

const LAUNCHER = "agent-launcher";
const DOCKER_SOCK = "/var/run/docker.sock";

interface ComposeConfig {
  services: Record<string, {
    environment?: Record<string, string | null>;
    volumes?: Array<{ source?: string; target?: string; read_only?: boolean }>;
    ports?: Array<unknown>;
    build?: { context?: string; dockerfile?: string };
  }>;
}

const BASE = ["docker-compose.yml"] as const;
const SMOKE = [...BASE, "docker-compose.smoke.yml"] as const;
const STAGE = [...SMOKE, "docker-compose.stage.yml"] as const;
/** The three compositions this repo actually boots. */
const COMPOSITIONS: ReadonlyArray<readonly string[]> = [BASE, SMOKE, STAGE];

// One `docker compose config` per composition, rendered once in beforeAll — the
// same reasoning as smoke-compose-config.test.ts's prewarm: shelling the Docker
// CLI costs seconds on a cold runner, which is enough to expire Bun's default
// per-test budget on a diff that changed nothing here.
const rendered = new Map<string, ComposeConfig>();

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // Never inherit the knobs the cases below assert the resolution of.
    if (["COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "SWARM_AGENT_LAUNCHER_URL", "SWARM_LAUNCHER_SPOOL_DIR"].includes(k)) continue;
    out[k] = v;
  }
  out.SMOKE_PROJECT = "launcher-compose-config-test";
  out.RM_STACK_ENV_CLASS = "local";
  out.RM_STACK_ENV_HASH = "launchercfg";
  out.WEB_PORT = "18787";
  out.POSTGRES_PORT = "15432";
  return out;
}

function renderComposeConfig(files: readonly string[]): ComposeConfig {
  const r = Bun.spawnSync(
    ["docker", "compose", ...files.flatMap((f) => ["-f", f]), "config", "--format", "json"],
    { cwd: repoRoot, env: env(), stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `docker compose config failed for ${files.join(" + ")} (exit ${r.exitCode}): ` +
        new TextDecoder().decode(r.stderr as Uint8Array),
    );
  }
  return JSON.parse(new TextDecoder().decode(r.stdout as Uint8Array)) as ComposeConfig;
}

function config(files: readonly string[]): ComposeConfig {
  const cached = rendered.get(files.join("+"));
  if (!cached) throw new Error(`composition ${files.join(" + ")} was not prewarmed`);
  return cached;
}

function socketHolders(cfg: ComposeConfig): string[] {
  return Object.entries(cfg.services)
    .filter(([, svc]) => (svc.volumes ?? []).some((v) => String(v.source ?? "").includes("docker.sock")))
    .map(([name]) => name)
    .sort();
}

describe("agent-launcher compose topology (Docker)", () => {
  beforeAll(() => {
    for (const files of COMPOSITIONS) rendered.set(files.join("+"), renderComposeConfig(files));
  }, 120_000);

  test("exactly one service holds the Docker socket, in every composition", () => {
    for (const files of COMPOSITIONS) {
      expect(socketHolders(config(files)), files.join(" + ")).toEqual([LAUNCHER]);
    }
  });

  test("neither api nor worker-swarm has it — the constraint the issue names", () => {
    for (const files of COMPOSITIONS) {
      for (const service of ["api", "worker-swarm", "worker-analytics", "worker-research", "analytics-producer", "website-server", "postgres"]) {
        const svc = config(files).services[service];
        if (!svc) continue;
        for (const v of svc.volumes ?? []) {
          expect(String(v.source ?? ""), `${service} in ${files.join(" + ")}`).not.toContain("docker.sock");
        }
      }
    }
  });

  test("the socket mount is the launcher's, at the canonical path, in every composition", () => {
    for (const files of COMPOSITIONS) {
      const mounts = (config(files).services[LAUNCHER]!.volumes ?? [])
        .filter((v) => String(v.source ?? "").includes("docker.sock"));
      expect(mounts, files.join(" + ")).toHaveLength(1);
      expect(mounts[0]!.source).toBe(DOCKER_SOCK);
      expect(mounts[0]!.target).toBe(DOCKER_SOCK);
    }
  });

  test("the launcher publishes NO host port — it is internal-network only", () => {
    // It has no authentication of its own, deliberately: its only caller is on
    // the compose network. A published port would hand anything that can reach
    // the host a container-start primitive.
    for (const files of COMPOSITIONS) {
      expect(config(files).services[LAUNCHER]!.ports ?? [], files.join(" + ")).toEqual([]);
    }
  });

  test("api and worker-swarm are told where the launcher is, in every composition", () => {
    for (const files of COMPOSITIONS) {
      for (const service of ["api", "worker-swarm"]) {
        expect(config(files).services[service]!.environment?.SWARM_AGENT_LAUNCHER_URL, `${service} in ${files.join(" + ")}`)
          .toBe(DEFAULT_JUDGE_LAUNCHER_URL);
      }
    }
    // The compose default and the code default are the SAME string. They are
    // declared in two files, so a rename in one and not the other would leave
    // the worker posting judgings into a hostname nothing answers on.
    expect(DEFAULT_JUDGE_LAUNCHER_URL).toBe(`http://${LAUNCHER}:${JUDGE_LAUNCHER_PORT}`);
  });

  test("the launcher gets its OWN credential copy and the spool bound at one path", () => {
    for (const files of COMPOSITIONS) {
      const svc = config(files).services[LAUNCHER]!;
      // Present as a key (blank by default, like every other credential in
      // these files) — the launcher refuses to START without a value, which is
      // where the loud failure belongs.
      expect(Object.keys(svc.environment ?? {}), files.join(" + ")).toContain("OPENCODE_API_KEY");
      expect(Object.keys(svc.environment ?? {})).toContain("SMOKE_PROJECT");
      // `-v` sources are resolved by the DAEMON against the HOST filesystem, so
      // the spool must mean the same path on both sides or every mount the
      // launcher builds would silently resolve to an empty directory.
      const spool = (svc.volumes ?? []).filter((v) => String(v.target ?? "").includes("rm-agent-launcher"));
      expect(spool, files.join(" + ")).toHaveLength(1);
      expect(spool[0]!.source).toBe(spool[0]!.target);
    }
  });

  test("the launcher is a RUNNING service of a full stack and a shipped image", () => {
    // Built but not started would mean every judging fails closed with
    // `launcher_unavailable` on a stack that looks healthy.
    expect(servicesFor("full")).toContain(LAUNCHER);
    expect(servicesFor("core")).not.toContain(LAUNCHER);
    expect([...LAUNCHER_SERVICES]).toEqual([LAUNCHER]);
    expect([...SHIPPED_IMAGE_SERVICES]).toContain(LAUNCHER);
    // And it is a real build target in the rendered config, not a bare `image:`
    // someone would have to have pushed somewhere.
    expect(config(SMOKE).services[LAUNCHER]!.build?.dockerfile).toContain("agent-launcher/Dockerfile");
  });
});
