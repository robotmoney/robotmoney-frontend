// `bun smoke:web [--instance <name>] [--rollback]` — deploy the static website
// and nothing else (D54; smoke spec §13.2, issue #1026 W7).
//
// IMAGE MODE (issue 1628, docs/technical/web-serving-architecture.md §4):
//
//   bun smoke:web --host <ssh-dest|local> --instance <name> --bundle <file|web-vA.B.C|serving> --server-image <ref> [--origin <url>]
//   bun smoke:web --host <ssh-dest|local> --instance <name> --rollback [--origin <url>]
//
// `--origin` is the public origin step 5 reads `/version.json` through. An ssh
// host needs it (issue 1630): without it step 5 would read the host's loopback
// port and record that as the public check. `local` may omit it.
// `--bundle serving` names the bundle the instance's website-server serves now,
// by the web tag its labels carry: a platform release keeps the serving bundle
// and rebuilds it on the server image it names (web-serving-architecture.md
// §5.3; the kitchen sink's Q24-site and C12-site). While no signed bundle
// serves (nginx, a host's first rollout, issue 1632) it changes nothing and
// exits 0.
//
// `--host` selects it. It runs here, on the control machine, and drives the
// host over SSH (`local` runs the host's commands on this machine). It
// deploys one signed bundle as an immutable website-server image, swapped on
// the public port, and writes its receipt under
// `<state root>/web-image/<instance>/`. The logic is the image-mode half of
// scripts/lib/website-release.ts. A `web-vA.B.C` bundle is downloaded from
// that tag's GitHub release (`gh release download`). Without `--host`, the
// directory mode below runs, unchanged, until the runbooks and the platform
// boots move to image mode (issues 1630, 1632).
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
import { WEB_BUNDLE_ALLOWED_SIGNERS } from "./lib/web-bundle.ts";
import { localHost, sshHost, type WebHost } from "./lib/website-host.ts";
import { WEBSITE_IMAGE_LABELS } from "./lib/website-image.ts";
import {
  deployImage,
  deploySite,
  INSTANCE_LABEL,
  SERVICE_LABEL,
  WEBSITE_SERVICE,
  resolveWebInstance,
  rollbackImage,
  rollbackSite,
  WEB_CONTENT_PATHS,
  type ImageReceipt,
  type ImageReleaseDeps,
  type WebReleaseDeps,
} from "./lib/website-release.ts";
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

const USAGE =
  "Usage: bun smoke:web [--instance <name>] [--rollback] | bun smoke:web --host <ssh-dest|local> --instance <name> " +
  "(--bundle <file|web-vA.B.C|serving> --server-image <ref> | --rollback) [--origin <url>, required for an ssh host]";
/** `--bundle serving`: the bundle the instance's website-server serves now. */
const SERVING_BUNDLE = "serving";
const VALUE_FLAGS = ["--instance", "--host", "--bundle", "--server-image", "--origin"] as const;
const argv = process.argv.slice(2);
const values: Partial<Record<(typeof VALUE_FLAGS)[number], string>> = {};
for (let i = 0; i < argv.length; i++) {
  const token = argv[i]!;
  if (token === "--rollback") continue;
  const flag = VALUE_FLAGS.find((f) => token === f || token.startsWith(`${f}=`));
  if (flag === undefined) fail(`Refusing: unknown argument ${token}. ${USAGE}`);
  const value = token === flag ? argv[++i] : token.slice(flag.length + 1);
  if (value === undefined || value === "") fail(`Refusing: ${flag} needs a value. ${USAGE}`);
  values[flag] = value;
}
const rollback = argv.includes("--rollback");

if (values["--host"] !== undefined) {
  await imageMode(values["--host"]);
  process.exit(0);
}
for (const flag of ["--bundle", "--server-image", "--origin"] as const) {
  if (values[flag] !== undefined) fail(`Refusing: ${flag} deploys a signed bundle image and needs --host. ${USAGE}`);
}

/** The web tag the instance's running website-server's labels name, or null while none does (nginx serves). */
async function servingTag(host: WebHost, instance: string): Promise<string | null> {
  const r = await host.run([
    "docker", "ps", "--filter", `label=${INSTANCE_LABEL}=${instance}`, "--filter", `label=${SERVICE_LABEL}=${WEBSITE_SERVICE}`,
    "--format", `{{.ID}}\t{{.Label "${WEBSITE_IMAGE_LABELS.tag}"}}`,
  ]);
  if (r.code !== 0) throw new Error(`Refusing: listing ${instance}'s website-server on ${host.name} failed: ${r.stderr || r.stdout}`);
  const rows = r.stdout.split("\n").filter((l) => l.trim() !== "");
  if (rows.length !== 1) throw new Error(`Refusing: ${host.name} runs ${rows.length} website-server containers for ${instance}, not one.`);
  const tag = rows[0]!.split("\t")[1]?.trim() ?? "";
  return tag === "" ? null : tag;
}

/** Image mode: one signed bundle, one immutable container, swapped on the host's public port. */
async function imageMode(hostName: string): Promise<void> {
  const instance = values["--instance"];
  if (instance === undefined) fail(`Refusing: image mode needs --instance (the host's instance). ${USAGE}`);
  if (rollback === (values["--bundle"] !== undefined)) fail(`Refusing: name exactly one of --bundle and --rollback. ${USAGE}`);
  if (!rollback && values["--server-image"] === undefined) fail(`Refusing: --bundle needs --server-image, the host's server image. ${USAGE}`);
  if (hostName !== "local" && values["--origin"] === undefined) {
    fail(`Refusing: an ssh host needs --origin, the public origin the swap's check reads (without it the check reads the host's loopback port). ${USAGE}`);
  }
  const host = hostName === "local" ? localHost() : sshHost(hostName);
  if (values["--bundle"] === SERVING_BUNDLE) {
    let tag: string | null;
    try {
      tag = await servingTag(host, instance);
    } catch (err) {
      host.close();
      fail(err instanceof Error ? err.message : String(err));
    }
    if (tag === null) {
      host.close();
      console.log(`${TAG} host ${host.name}, instance ${instance}: no signed bundle serves yet (a host's first rollout keeps its running website-server); nothing to deploy`);
      return;
    }
    console.log(`${TAG} host ${host.name}, instance ${instance}: the serving bundle is ${tag}`);
    values["--bundle"] = tag;
  }
  const deps: ImageReleaseDeps = {
    host,
    instance,
    receiptDir: join(stateRoot(process.env), "web-image", instance),
    repoRoot,
    allowedSigners: WEB_BUNDLE_ALLOWED_SIGNERS,
    publicOrigin: values["--origin"],
    async fetchRelease(tag, dir) {
      const r = Bun.spawnSync(["gh", "release", "download", tag, "--pattern", "robotmoney-web-*", "--dir", dir], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
      if (r.exitCode !== 0) throw new Error(`gh release download ${tag} failed: ${r.stderr.toString().trim()}`);
    },
    log: (line) => console.log(`${TAG} ${line}`),
  };
  console.log(`${TAG} host ${host.name}, instance ${instance}: ${rollback ? "rolling back to the previous image" : `deploying ${values["--bundle"]}`}`);
  let receipt: ImageReceipt;
  try {
    receipt = rollback ? await rollbackImage(deps) : await deployImage({ bundle: values["--bundle"]!, serverImage: values["--server-image"]! }, deps);
  } catch (err) {
    console.error(`${TAG} receipt: ${join(deps.receiptDir, "receipt.json")}`);
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    host.close();
  }
  const gap = receipt.gap?.ms === null || receipt.gap === null ? "no swap" : `gap ${receipt.gap.ms} ms`;
  console.log(`${TAG} ${receipt.outcome}: ${receipt.release?.tag ?? "?"} (${receipt.newContainer?.id.slice(0, 12) ?? "no new container"}), ${gap}`);
  console.log(`${TAG} receipt: ${join(deps.receiptDir, "receipt.json")}`);
}

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
  sourceIdentity: () => resolveSourceTrees(gitRunner(repoRoot), WEB_CONTENT_PATHS),
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
