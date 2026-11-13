// Shared by the image-mode `bun smoke:web` integration tests (issue 1628):
// smoke-web-lifecycle.test.ts and smoke-web-rolling.test.ts, and the first
// rollout from nginx (issue 1632): smoke-web-first-rollout.test.ts.
//
// A real Docker "host" on this machine (website-host.ts localHost), shaped
// like one instance of a `bun smoke` stack as far as website-server is
// concerned:
//
//   - a server image built from website-server/Dockerfile.caddy, trusting only
//     a keypair made here (no real signing key is used or written);
//   - a network with a stand-in `api` (oven/bun) that answers /api/version;
//   - a running website-server: a site image of the first bundle, run with the
//     overlay's flags, the compose and instance labels `bun smoke` gives it, a
//     Docker-assigned loopback port, a restart policy and a healthcheck.
//     With `firstServer: "nginx"` it is instead the nginx website-server
//     (website-server/Dockerfile) serving a web/ directory mounted from the
//     host, as a host runs before its first image swap, on a fixed loopback
//     port as a standing host's stage overlay fixes 48787.
//
// Bundles are the fixture site with a version, a commit and a range of the
// test's choosing, packed and signed by web-bundle.ts. Everything is removed
// by `dispose()`.
//
// LOUD, NEVER SKIPPED: Docker and ssh-keygen are hard dependencies. Without
// them `createImageHost` throws and every test in the file fails.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packBundle, signBundle } from "../../lib/web-bundle.ts";
import { WEB_BUNDLE_SIGNATURE_NAMESPACE } from "../../lib/web-bundle-manifest.ts";
import { localHost, type WebHost } from "../../lib/website-host.ts";
import { readWebsiteImageService, websiteImageRunFlags } from "../../lib/website-image.ts";
import { SERVER_PIN_REPO, SITE_IMAGE_INSTANCE_LABEL, siteImageTag, type ImageReleaseDeps } from "../../lib/website-release.ts";

export const repoRoot = join(import.meta.dir, "..", "..", "..");
export const API_VERSION = "0.2.0";
const BUN_IMAGE = "oven/bun:1.4.4";

const STAND_IN_API = `Bun.serve({ port: 8787, hostname: "0.0.0.0", fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/api/version") return Response.json({ api: "${API_VERSION}", commit: "c0ffee0" });
  return Response.json({ path });
} });`;

export const docker = (args: string[], input?: string): string =>
  execFileSync("docker", args, { cwd: repoRoot, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] }).toString().trim();

export const tryDocker = (args: string[]): void => {
  try {
    docker(args);
  } catch {
    /* already gone */
  }
};

export interface BundleSpec {
  readonly version: string;
  readonly commit: string;
  readonly apiRange?: string | null;
  /** Leave out index.html and _shell.html: the site builds and fails the copy check. */
  readonly broken?: boolean;
}

export interface ImageHost {
  readonly instance: string;
  readonly project: string;
  readonly serverImage: string;
  readonly network: string;
  readonly host: WebHost;
  readonly work: string;
  /** The control machine's allowed-signers file (the test key). */
  readonly allowedSigners: string;
  /** Pack and sign a fixture bundle with the trusted key. Returns the tarball's path. */
  bundle(spec: BundleSpec, key?: string): string;
  /** A keypair no allowed-signers file lists. */
  rogueKey(): string;
  /** Deps for website-release.ts's image mode, with a fresh receipt directory. */
  deps(extra?: Partial<ImageReleaseDeps>): ImageReleaseDeps;
  /** The running website-server of the instance, as `docker inspect` reads it. */
  serving(): { id: string; name: string; image: string; port: number; startedAt: string };
  /** /version.json on the public port. */
  served(): Promise<{ version: string; commit: string } | null>;
  /** The ids of every image labelled with the instance. */
  instanceImages(): string[];
  /** The image id a tag names, or null. */
  imageId(ref: string): string | null;
  dispose(): void;
}

function keypair(work: string, name: string): string {
  const key = join(work, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", key]);
  return key;
}

/** Build the server image and bring up the instance's api and its first website-server, serving `first`. */
export function createImageHost(label: string, first: BundleSpec, opts: { firstServer?: "site" | "nginx" } = {}): ImageHost {
  const run = `${label}-${process.pid}-${Date.now().toString(36)}`;
  const instance = `rm_swt_${run.replace(/-/g, "_")}`;
  const project = instance;
  const serverImage = `rm-website-server-swap-test:${run}`;
  const nginxImage = `rm-website-nginx-swap-test:${run}`;
  const network = `rm-swt-net-${run}`;
  const work = mkdtempSync(join(tmpdir(), "rm-swt-"));
  const key = keypair(work, "swap-signer");
  const pub = readFileSync(`${key}.pub`, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
  const allowedSigners = join(work, "allowed-signers");
  writeFileSync(allowedSigners, `swap-signer namespaces="${WEB_BUNDLE_SIGNATURE_NAMESPACE}" ${pub}\n`);
  const containers: string[] = [];
  let rogue = 0;
  let receipts = 0;

  const bundle = (spec: BundleSpec, signer: string = key): string => {
    const site = join(work, `site-${spec.version}-${spec.commit}-${receipts++}`);
    mkdirSync(join(site, "assets"), { recursive: true });
    if (!spec.broken) {
      writeFileSync(join(site, "index.html"), `<!doctype html><title>home ${spec.version}</title>`);
      writeFileSync(join(site, "_shell.html"), `<!doctype html><title>shell ${spec.version}</title>`);
    }
    writeFileSync(join(site, "assets", "app.js"), `export const v = "${spec.version}";\n`);
    writeFileSync(join(site, "version.json"), JSON.stringify({ version: spec.version, commit: spec.commit, apiRange: spec.apiRange === undefined ? "^0.2.0" : spec.apiRange }));
    const out = join(work, `bundle-${spec.version}-${spec.commit}-${receipts++}`);
    const packed = packBundle(site, out);
    signBundle(packed.path, signer);
    return packed.path;
  };

  const hostApi: ImageHost = {
    instance,
    project,
    serverImage,
    network,
    host: localHost(),
    work,
    allowedSigners,
    bundle,
    rogueKey: () => keypair(work, `rogue-${rogue++}`),
    deps(extra = {}) {
      return {
        host: localHost(),
        instance,
        receiptDir: join(work, `receipts-${receipts++}`),
        repoRoot,
        allowedSigners,
        log: (line) => console.log(`[smoke:web ${instance}] ${line}`),
        ...extra,
      };
    },
    serving() {
      const id = docker(["ps", "-q", "--no-trunc", "--filter", `label=robotmoney.instance=${instance}`, "--filter", "label=com.docker.compose.service=website-server"]);
      if (id === "" || id.includes("\n")) throw new Error(`expected one running website-server for ${instance}, got ${JSON.stringify(id)}`);
      const [name, image, startedAt] = docker(["inspect", "--format", "{{.Name}}|{{.Image}}|{{.State.StartedAt}}", id]).split("|");
      const port = Number(docker(["port", id, "8080/tcp"]).split("\n")[0]!.split(":").pop());
      return { id, name: name!.replace(/^\//, ""), image: image!, port, startedAt: startedAt! };
    },
    async served() {
      try {
        const res = await fetch(`http://127.0.0.1:${hostApi.serving().port}/version.json`, { signal: AbortSignal.timeout(2_000) });
        return res.ok ? ((await res.json()) as { version: string; commit: string }) : null;
      } catch {
        return null;
      }
    },
    instanceImages() {
      return [...new Set(docker(["images", "-q", "--no-trunc", "--filter", `label=${SITE_IMAGE_INSTANCE_LABEL}=${instance}`]).split("\n").filter((l) => l !== ""))].sort();
    },
    imageId(ref) {
      try {
        return docker(["image", "inspect", "--format", "{{.Id}}", ref]);
      } catch {
        return null;
      }
    },
    dispose() {
      const ids = docker(["ps", "-aq", "--filter", `label=robotmoney.instance=${instance}`]).split("\n").filter((l) => l !== "");
      for (const id of [...ids, ...containers]) tryDocker(["rm", "-f", "-v", id]);
      tryDocker(["network", "rm", `robotmoney-web-lock-${instance}`]);
      tryDocker(["network", "rm", network]);
      for (const id of hostApi.instanceImages()) tryDocker(["rmi", "-f", id]);
      for (const slot of ["current", "previous", "candidate"] as const) tryDocker(["rmi", siteImageTag(instance, slot)]);
      // smoke:web pins the server image by a tag named for its id; it goes with the server image.
      const serverId = hostApi.imageId(serverImage);
      if (serverId !== null) tryDocker(["rmi", `${SERVER_PIN_REPO}:${serverId.replace(/^sha256:/, "")}`]);
      tryDocker(["rmi", "-f", serverImage]);
      tryDocker(["rmi", "-f", nginxImage]);
      rmSync(work, { recursive: true, force: true });
    },
  };

  try {
    // The server image, trusting only this test's key.
    const serverDir = join(work, "website-server");
    cpSync(join(repoRoot, "website-server"), serverDir, { recursive: true });
    writeFileSync(join(serverDir, "allowed-signers"), readFileSync(allowedSigners));
    const platformCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
    docker(["build", "-q", "-t", serverImage, "--build-arg", `PLATFORM_COMMIT=${platformCommit}`, "-f", join(serverDir, "Dockerfile.caddy"), serverDir]);

    docker(["network", "create", network]);
    const api = docker([
      "run", "-d", "--name", `rm-swt-api-${run}`, "--network", network, "--network-alias", "api",
      "--label", `com.docker.compose.project=${project}`, "--label", "com.docker.compose.service=api",
      BUN_IMAGE, "bun", "-e", STAND_IN_API,
    ]);
    containers.push(api);

    if (opts.firstServer === "nginx") {
      // Before the first swap: nginx serving web/current, a symlink to the site's directory (smoke-site.ts).
      const web = join(work, "web");
      const site = join(web, `${first.version}-${first.commit}`);
      mkdirSync(site, { recursive: true });
      writeFileSync(join(site, "index.html"), `<!doctype html><title>home ${first.version}</title>`);
      writeFileSync(join(site, "_shell.html"), `<!doctype html><title>shell ${first.version}</title>`);
      writeFileSync(join(site, "version.json"), JSON.stringify({ version: first.version, commit: first.commit, apiRange: first.apiRange === undefined ? "^0.2.0" : first.apiRange }));
      symlinkSync(`${first.version}-${first.commit}`, join(web, "current"));
      docker(["build", "-q", "-t", nginxImage, "-f", join(repoRoot, "website-server", "Dockerfile"), join(repoRoot, "website-server")]);
      const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
      const port = probe.port;
      probe.stop(true);
      docker([
        "run", "-d", "--name", `${project}-website-server-1`, "--network", network, "--network-alias", "website-server",
        "--label", `com.docker.compose.project=${project}`, "--label", "com.docker.compose.service=website-server",
        "--label", `robotmoney.instance=${instance}`, "--restart", "unless-stopped",
        "--health-cmd", "wget -q -O /dev/null http://127.0.0.1:8080/", "--health-interval", "15s",
        "-v", `${web}:/srv/web:ro`, "-p", `127.0.0.1:${port}:8080`, nginxImage,
      ]);
      return hostApi;
    }

    // The first site image, built the way smoke:web builds one, and run the way a stack runs website-server.
    const first1 = bundle(first);
    const bundleDir = join(first1, "..");
    const sha256 = readFileSync(`${first1}.sha256`, "utf8").split(/\s+/)[0]!;
    const firstImage = `${siteImageTag(instance, "current")}`;
    docker([
      "build", "-q", "--label", `${SITE_IMAGE_INSTANCE_LABEL}=${instance}`, "-t", firstImage,
      "-f", join(repoRoot, "website-server", "Dockerfile.bundle"), "--build-context", `bundle=${bundleDir}`,
      "--build-arg", `SERVER_IMAGE=${serverImage}`, "--build-arg", `WEB_TAG=web-v${first.version}`,
      "--build-arg", `WEB_COMMIT=${first.commit}`, "--build-arg", `BUNDLE_SHA256=${sha256}`,
      join(repoRoot, "website-server"),
    ]);
    const flags = websiteImageRunFlags(readWebsiteImageService(repoRoot));
    docker([
      "run", "-d", "--name", `${project}-website-server-1`, "--network", network, "--network-alias", "website-server",
      "--label", `com.docker.compose.project=${project}`, "--label", "com.docker.compose.service=website-server",
      "--label", `robotmoney.instance=${instance}`, "--restart", "unless-stopped",
      "--health-cmd", "wget -q -O /dev/null http://127.0.0.1:8080/", "--health-interval", "15s",
      ...flags, "-p", "127.0.0.1::8080", firstImage,
    ]);
  } catch (error) {
    hostApi.dispose();
    throw error;
  }
  return hostApi;
}

/** Wait until the public port names `want`. */
export async function waitServed(h: ImageHost, want: { version: string; commit: string }, deadlineMs = 30_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const got = await h.served();
    if (got?.version === want.version && got.commit === want.commit) return;
    if (Date.now() > deadline) throw new Error(`the public port serves ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
    await Bun.sleep(100);
  }
}
