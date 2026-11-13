// `bun smoke:web` — deploy the static website and nothing else (D54; smoke
// spec §13.2, issue #1026 W7), in image mode (issue 1628,
// docs/technical/web-serving-architecture.md §4):
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
// It runs here, on the control machine, and drives the host over SSH (`local`
// runs the host's commands on this machine). It deploys one signed bundle as an
// immutable website-server image, swapped on the public port, and writes its
// receipt under `<state root>/web-image/<instance>/`. The logic is
// scripts/lib/website-release.ts. A `web-vA.B.C` bundle is downloaded from that
// tag's GitHub release (`gh release download`).
//
// `--host` is required. The directory mode that built the site from this
// checkout into the instance's `web/` directory and reloaded nginx is retired
// (issue 1631): a run without `--host` refuses and changes nothing. A host
// before its first swap still serves the site its last `bun smoke` placed.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stateRoot } from "./lib/smoke-state.ts";
import { WEB_BUNDLE_ALLOWED_SIGNERS } from "./lib/web-bundle.ts";
import { localHost, sshHost, type WebHost } from "./lib/website-host.ts";
import { WEBSITE_IMAGE_LABELS } from "./lib/website-image.ts";
import {
  deployImage,
  INSTANCE_LABEL,
  SERVICE_LABEL,
  WEBSITE_SERVICE,
  rollbackImage,
  type ImageReceipt,
  type ImageReleaseDeps,
} from "./lib/website-release.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TAG = "[smoke:web]";

function fail(message: string): never {
  console.error(`${TAG} ${message}`);
  process.exit(1);
}

const USAGE =
  "Usage: bun smoke:web --host <ssh-dest|local> --instance <name> " +
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

if (values["--host"] === undefined) {
  fail(
    "Refusing: --host is required. The directory mode (web/current and an nginx reload) is retired (issue 1631); " +
      `a site ships as a signed bundle image. Nothing was changed. ${USAGE}`,
  );
}
await imageMode(values["--host"]);
process.exit(0);

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
