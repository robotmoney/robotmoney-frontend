// `bun smoke:web [--instance <name>] [--rollback]` — deploy the static website
// and nothing else (D54; smoke spec §13.2, issue #1026 W7).
//
// Builds the site from this checkout into the instance's `web/` directory,
// refuses when the running API's version is outside the site's range, switches
// `website-server` to it and reloads nginx, and writes a journal and receipt
// under `web/`. `--rollback` returns to the previous site. The logic is
// scripts/lib/website-release.ts; this file resolves the instance and wires the
// real side effects:
//
//   build     `bash scripts/static-assembly.sh <dir>`, with the same RM_BUILD_*
//             identity `bun smoke` hands its assembly (scripts/stack/stack.ts);
//   API       GET /api/version on the instance's `api`, at the host port
//             `docker compose port` reports;
//   reload    `docker compose exec -T website-server nginx -s reload`, from the
//             host. No container is given the Docker socket;
//   check     GET /version.json through `website-server` until it reports the
//             new site.
//
// Every compose call is scoped to the instance's recorded project and compose
// files (its stack record), with the environment `smoke:down` rebuilds: the
// host's environment reaches compose through the docker-client allowlist only.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homeEnvFilePath, loadEnvFile } from "./lib/env-role.ts";
import { resolveRmEnv } from "./lib/smoke-env-policy.ts";
import { buildSmokeLifecycleComposeEnv } from "./lib/smoke-lifecycle-env.ts";
import { instanceFlag, readStackState, stateRoot, type InstancePaths, type StackStateRecord } from "./lib/smoke-state.ts";
import { deploySite, resolveWebInstance, rollbackSite, WEB_SOURCE_CONTEXTS, type WebReleaseDeps } from "./lib/website-release.ts";
import { resolveBuildIdentityEnv } from "./stack/build-identity.ts";
import { instanceComposeEnv } from "./stack/config.ts";
import { resolveStackEnvironment } from "./stack/naming.ts";
import { gitRunner, resolveSourceTrees } from "./stack/source-identity.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAG = "[smoke:web]";

function fail(message: string): never {
  console.error(`${TAG} ${message}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const token = argv[i]!;
  if (token === "--rollback" || token.startsWith("--instance=")) continue;
  if (token === "--instance") {
    i++;
    continue;
  }
  fail(`Refusing: unknown argument ${token}. Usage: bun smoke:web [--instance <name>] [--rollback]`);
}
const rollback = argv.includes("--rollback");

let paths: InstancePaths;
let stack: StackStateRecord | null;
try {
  // RM_ENV from the process, else from `~/.env` (spec §3), exactly as `bun smoke` reads it.
  const policy = resolveRmEnv({ RM_ENV: process.env.RM_ENV ?? loadEnvFile(homeEnvFilePath())?.RM_ENV });
  if (!policy.ok) fail(policy.reason);
  paths = resolveWebInstance({
    flag: instanceFlag(argv),
    rmEnv: policy.env,
    environment: resolveStackEnvironment(process.env),
    stateRoot: stateRoot(process.env),
  });
  stack = readStackState(paths);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
const instance = paths.dir.split("/").at(-1)!;
if (stack === null) {
  fail(`Refusing: instance ${instance} has no stack record (${paths.stackStateFile}); bring its stack up with \`bun smoke\` first.`);
}

const composeEnv = {
  ...buildSmokeLifecycleComposeEnv(stack, process.env),
  ...instanceComposeEnv({ name: instance, stateDir: paths.dir }),
};

/** `docker compose …` for this instance's project, from the repository root. */
function compose(args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["docker", "compose", "--env-file", "/dev/null", ...args], {
    cwd: repoRoot,
    env: composeEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode ?? 1, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

/** The host port Docker published for `service`'s container port. */
function hostPort(service: string, containerPort: number): number {
  const r = compose(["port", service, String(containerPort)]);
  const port = Number(r.out.split("\n")[0]?.split(":").pop());
  if (r.code !== 0 || !Number.isInteger(port) || port <= 0) {
    throw new Error(`\`docker compose port ${service} ${containerPort}\` gave no port (${r.err || r.out || `exit ${r.code}`}); is instance ${instance}'s stack up?`);
  }
  return port;
}

const deps: WebReleaseDeps = {
  async build(outDir) {
    const identity = resolveBuildIdentityEnv((a) => {
      const r = Bun.spawnSync(a, { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
      return { exitCode: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    });
    console.log(`${TAG} assembling the site into ${outDir}…`);
    const proc = Bun.spawn(["bash", join(repoRoot, "scripts", "static-assembly.sh"), outDir], {
      cwd: repoRoot,
      env: { ...process.env, ...identity },
      stdout: "inherit",
      stderr: "inherit",
    });
    const code = await proc.exited;
    if (code !== 0) throw new Error(`scripts/static-assembly.sh exited ${code}`);
  },
  async apiVersion() {
    const res = await fetch(`http://127.0.0.1:${hostPort("api", 8787)}/api/version`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`GET /api/version answered ${res.status}`);
    const body = (await res.json()) as { api?: unknown };
    if (typeof body.api !== "string") throw new Error("GET /api/version carried no `api` version");
    return body.api;
  },
  async reload() {
    const r = compose(["exec", "-T", "website-server", "nginx", "-s", "reload"]);
    if (r.code !== 0) throw new Error(`nginx reload in website-server failed (exit ${r.code}): ${r.err || r.out}`);
  },
  async verifyServed(site) {
    const url = `http://127.0.0.1:${hostPort("website-server", 8080)}/version.json`;
    const deadline = Date.now() + 15_000;
    let seen = "";
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
        const body = (await res.json()) as { version?: unknown; commit?: unknown };
        if (body.version === site.version && body.commit === site.commit) return;
        seen = `${String(body.version)}-${String(body.commit)}`;
      } catch (err) {
        seen = err instanceof Error ? err.message : String(err);
      }
      await Bun.sleep(250);
    }
    throw new Error(`website-server still serves ${seen}, not ${site.version}-${site.commit}`);
  },
  sourceIdentity: () => resolveSourceTrees(gitRunner(repoRoot), WEB_SOURCE_CONTEXTS),
  log: (line) => console.log(`${TAG} ${line}`),
};

try {
  console.log(`${TAG} instance ${instance} (project ${stack.project}): ${rollback ? "rolling back to the previous site" : "deploying the site from this checkout"}`);
  const receipt = rollback ? await rollbackSite(paths, deps) : await deploySite(paths, deps);
  console.log(
    `${TAG} ${receipt.swapped ? `now serving ${receipt.siteId} (was ${receipt.previous ?? "none"})` : `${receipt.siteId} was already current`}; ` +
      `API ${receipt.apiVersion} in range ${receipt.apiRange}; plan ${receipt.planId}`,
  );
  console.log(`${TAG} receipt: ${join(paths.webDir, "receipt.json")}`);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
