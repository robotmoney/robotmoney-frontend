// The immutable website-server image (issue 1627, docs/technical/web-serving-
// architecture.md §3.2): the server image plus exactly one signed bundle,
// verified in a build stage, run with docker-compose.website-image.yml's flags.
//
// Real images, real Docker. The test makes its own ed25519 keypair and its own
// allowed-signers file, and builds the server image from a scratch copy of
// website-server/ that holds that file instead of the committed one. No real
// signing key is used or written anywhere. A second keypair, which no
// allowed-signers file lists, signs the bundle that must fail the build.
//
// What it proves, in order:
//   - a correctly signed bundle builds, and the image's labels are the bundle's
//     tag, commit and digest plus the server image's platform commit;
//   - the image carries no Bun or Node binary;
//   - the container runs read-only, non-root, with no volume, as the overlay says;
//   - the P1 route and header table passes against it, api up and api down;
//   - `docker diff` lists nothing under the served root after all of that;
//   - a bundle signed by an unlisted key, or labelled with another commit,
//     fails the build;
//   - a correctly signed bundle that carries a hardlink fails the build
//     (issue 1628: BusyBox tar lists a hardlink as a regular file).
//
// Every table run prints `route-table server=bundle-image phase=<phase>: N/N
// rows passed`, which integration.yml greps, so a skipped run is never green.
//
// LOUD, NEVER SKIPPED: Docker and ssh-keygen are hard dependencies of this
// tier. Everything started here is removed in afterAll.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { MAINTENANCE_FILE } from "../../lib/maintenance-file.ts";
import { KEPT_WEB_SERVICE, makeDockerRunner, stopProjectExcept } from "../../lib/smoke-volumes.ts";
import { packBundle, signBundle } from "../../lib/web-bundle.ts";
import { WEB_BUNDLE_SIGNATURE_NAMESPACE, bundleFileName, digestStatement } from "../../lib/web-bundle-manifest.ts";
import { createHash } from "node:crypto";
import {
  WEBSITE_IMAGE_LABELS,
  WEBSITE_SERVED_ROOT,
  assertServedRootUnchanged,
  readWebsiteImageService,
  websiteImageRunFlags,
} from "../../lib/website-image.ts";
import { MAINTENANCE_STATUS, SITE_FILES, SITE_VERSION, TABLE } from "../support/website-routes-table.ts";

const repoRoot = join(import.meta.dir, "../../..");
const RUNNER = join(repoRoot, "scripts/tests/support/website-routes-runner.ts");
const RUN = `${process.pid}-${Date.now().toString(36)}`;
const SERVER_IMAGE = `rm-website-server-p4-server:${RUN}`;
const IMAGE = `rm-website-server-p4:${RUN}`;
const NETWORK = `rm-wsb-net-${RUN}`;
const API_CONTAINER = `rm-wsb-api-${RUN}`;
const WEB_CONTAINER = `rm-wsb-web-${RUN}`;
const BUN_IMAGE = "oven/bun:1.4.4";
const PROJECT = `rm_wsb_${RUN.replace(/-/g, "_")}`;
const labels = (service: string) => ["--label", `com.docker.compose.project=${PROJECT}`, "--label", `com.docker.compose.service=${service}`];
const PLATFORM_COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
const WEB_TAG = `web-v${SITE_VERSION.version}`;

const ECHO_API = `Bun.serve({ port: 8787, hostname: "0.0.0.0", fetch(req) {
  return Response.json({ path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers) });
} });`;

const work = mkdtempSync(join(tmpdir(), "rm-wsb-"));
let bundle = { dir: "", sha256: "" };
let signerKey = "";
let webPort = 0;

const docker = (args: string[]): string => execFileSync("docker", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const tryDocker = (args: string[]): void => {
  try {
    docker(args);
  } catch {
    /* already gone */
  }
};

function keypair(name: string): string {
  const key = join(work, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", name, "-f", key]);
  return key;
}

/** Pack the fixture site, sign it with `key`, and return the directory holding the three files. */
function signedBundle(name: string, key: string): { dir: string; sha256: string } {
  const site = join(work, `${name}-site`);
  for (const [rel, body] of Object.entries(SITE_FILES)) {
    mkdirSync(dirname(join(site, rel)), { recursive: true });
    writeFileSync(join(site, rel), body);
  }
  const dir = join(work, `${name}-bundle`);
  const packed = packBundle(site, dir);
  signBundle(packed.path, key);
  return { dir, sha256: packed.sha256 };
}

/** Build the website-server image from `bundleDir`. Returns the exit code and the build output. */
function buildImage(tag: string, bundleDir: string, args: { commit: string; sha256: string }): { code: number; out: string } {
  const r = spawnSync(
    "docker",
    [
      "build", "-t", tag, "-f", join(repoRoot, "website-server/Dockerfile.bundle"),
      "--build-context", `bundle=${bundleDir}`,
      "--build-arg", `SERVER_IMAGE=${SERVER_IMAGE}`,
      "--build-arg", `WEB_TAG=${WEB_TAG}`,
      "--build-arg", `WEB_COMMIT=${args.commit}`,
      "--build-arg", `BUNDLE_SHA256=${args.sha256}`,
      join(repoRoot, "website-server"),
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

async function runTable(origin: string, phase: "api-up" | "api-down"): Promise<void> {
  const proc = Bun.spawn(["bun", RUNNER, phase], { env: { ...process.env, ROUTES_TARGET_URL: origin }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  console.log(out + err);
  const rows = TABLE.filter((r) => r.phase === phase).length;
  const summary = `${rows}/${rows} rows passed (${phase})`;
  if (code === 0 && out.includes(summary)) console.log(`route-table server=bundle-image phase=${phase}: ${summary}`);
  expect(out).toContain(summary);
  expect(out).not.toContain("FAIL");
  expect(code).toBe(0);
}

async function waitFor(url: string, ok: (r: Response) => boolean, deadlineMs = 60_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const res = await fetch(url).catch(() => null);
    if (res && ok(res)) return;
    if (Date.now() > deadline) throw new Error(`no acceptable answer from ${url}`);
    await Bun.sleep(250);
  }
}

beforeAll(() => {
  // The server image, trusting only this test's key.
  const key = keypair("p4-signer");
  signerKey = key;
  const serverDir = join(work, "website-server");
  cpSync(join(repoRoot, "website-server"), serverDir, { recursive: true });
  const pub = readFileSync(`${key}.pub`, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
  writeFileSync(join(serverDir, "allowed-signers"), `p4-signer namespaces="${WEB_BUNDLE_SIGNATURE_NAMESPACE}" ${pub}\n`);
  docker(["build", "-t", SERVER_IMAGE, "--build-arg", `PLATFORM_COMMIT=${PLATFORM_COMMIT}`, "-f", join(serverDir, "Dockerfile.caddy"), serverDir]);

  bundle = signedBundle("good", key);
  const built = buildImage(IMAGE, bundle.dir, { commit: SITE_VERSION.commit, sha256: bundle.sha256 });
  if (built.code !== 0) throw new Error(`the signed bundle did not build:\n${built.out}`);

  docker(["network", "create", NETWORK]);
  docker(["run", "-d", "--name", API_CONTAINER, "--network", NETWORK, "--network-alias", "api", ...labels("api"), BUN_IMAGE, "bun", "-e", ECHO_API]);
  // Exactly the overlay's flags, and no -v: the site is the image's.
  const flags = websiteImageRunFlags(readWebsiteImageService(repoRoot));
  docker(["run", "-d", "--name", WEB_CONTAINER, "--network", NETWORK, ...labels(KEPT_WEB_SERVICE), ...flags, "-p", "127.0.0.1::8080", IMAGE]);
  webPort = Number(docker(["port", WEB_CONTAINER, "8080/tcp"]).split("\n")[0]!.split(":").pop());
  expect(webPort).toBeGreaterThan(0);
}, 600_000);

afterAll(() => {
  tryDocker(["rm", "-f", "-v", WEB_CONTAINER]);
  tryDocker(["rm", "-f", "-v", API_CONTAINER]);
  tryDocker(["network", "rm", NETWORK]);
  tryDocker(["rmi", "-f", IMAGE]);
  tryDocker(["rmi", "-f", SERVER_IMAGE]);
  rmSync(work, { recursive: true, force: true });
}, 120_000);

test("the labels are the bundle's tag, commit and digest, and the server image's platform commit", () => {
  const got = JSON.parse(docker(["image", "inspect", "--format", "{{json .Config.Labels}}", IMAGE])) as Record<string, string>;
  expect({
    tag: got[WEBSITE_IMAGE_LABELS.tag],
    commit: got[WEBSITE_IMAGE_LABELS.commit],
    sha256: got[WEBSITE_IMAGE_LABELS.bundleSha256],
    server: got[WEBSITE_IMAGE_LABELS.serverCommit],
  }).toEqual({ tag: WEB_TAG, commit: SITE_VERSION.commit, sha256: bundle.sha256, server: PLATFORM_COMMIT });
  // The running container reads the same labels back (R5).
  expect(docker(["inspect", "--format", `{{index .Config.Labels "${WEBSITE_IMAGE_LABELS.bundleSha256}"}}`, WEB_CONTAINER])).toBe(bundle.sha256);
});

test("the image carries no bun or node binary", () => {
  const history = docker(["history", "--no-trunc", IMAGE]);
  expect(history.split("\n").filter((l) => /\b(bun|node|npm|npx)\b/i.test(l))).toEqual([]);
  const found = docker(["run", "--rm", "--user", "0", "--entrypoint", "find", IMAGE, "/", "-xdev", "-type", "f", "(", "-name", "bun", "-o", "-name", "node", "-o", "-name", "npm", ")"]);
  expect(found).toBe("");
  console.log(`website-server image size: ${docker(["image", "inspect", "--format", "{{.Size}}", IMAGE])} bytes`);
}, 120_000);

test("the container runs read-only and non-root, with no volume and every capability dropped", () => {
  const host = JSON.parse(docker(["inspect", "--format", "{{json .HostConfig}}", WEB_CONTAINER])) as {
    ReadonlyRootfs: boolean;
    CapDrop: string[] | null;
    SecurityOpt: string[] | null;
    Binds: string[] | null;
  };
  expect(host.ReadonlyRootfs).toBe(true);
  expect(host.CapDrop).toEqual(["ALL"]);
  expect(host.SecurityOpt).toContain("no-new-privileges:true");
  expect(host.Binds ?? []).toEqual([]);
  expect(docker(["inspect", "--format", "{{json .Mounts}}", WEB_CONTAINER])).toBe("[]");
  expect(docker(["exec", WEB_CONTAINER, "id", "-u"])).toBe("65534");
  expect(() => docker(["exec", WEB_CONTAINER, "touch", `${WEBSITE_SERVED_ROOT}/current/probe`])).toThrow();
  // The served root holds exactly the bundle: its files plus the manifest the packer adds.
  const served = docker(["exec", WEB_CONTAINER, "find", `${WEBSITE_SERVED_ROOT}/current`, "-type", "f"]).split("\n").map((p) => p.slice(`${WEBSITE_SERVED_ROOT}/current/`.length)).sort();
  expect(served).toEqual([...Object.keys(SITE_FILES), ".rm-bundle-manifest.json"].sort());
}, 60_000);

test("the P1 route and header table passes on the immutable image (api up)", async () => {
  const origin = `http://127.0.0.1:${webPort}`;
  await waitFor(`${origin}/health`, (r) => r.status === 200);
  await runTable(origin, "api-up");
}, 120_000);

test("the P1 route and header table passes on the immutable image with the api stopped (maintenance)", async () => {
  // A maintenance window is announced into the in-memory maintenance directory,
  // never the served root.
  execFileSync("docker", ["exec", "-i", WEB_CONTAINER, "sh", "-c", `cat > /srv/maintenance/${MAINTENANCE_FILE}`], { input: JSON.stringify(MAINTENANCE_STATUS) });
  const stopped = stopProjectExcept(makeDockerRunner(), PROJECT, [KEPT_WEB_SERVICE]);
  expect(stopped).toEqual({ removed: [API_CONTAINER], kept: [WEB_CONTAINER] });
  const origin = `http://127.0.0.1:${webPort}`;
  await waitFor(`${origin}/api/anything`, (r) => r.status === 503);
  await runTable(origin, "api-down");
}, 120_000);

test("docker diff lists nothing under the served root after serving and a maintenance window", () => {
  const diff = docker(["diff", WEB_CONTAINER]);
  console.log(`docker diff ${WEB_CONTAINER}:\n${diff || "(empty)"}`);
  expect(diff.split("\n").filter((l) => l.includes(WEBSITE_SERVED_ROOT))).toEqual([]);
  assertServedRootUnchanged(docker, WEB_CONTAINER);
});

test("a bundle signed by a key the server image does not list fails the build", () => {
  const rogue = signedBundle("rogue", keypair("rogue-signer"));
  const r = buildImage(`${IMAGE}-rogue`, rogue.dir, { commit: SITE_VERSION.commit, sha256: rogue.sha256 });
  tryDocker(["rmi", "-f", `${IMAGE}-rogue`]);
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("web bundle refused: no key in /etc/robotmoney/allowed-signers signed");
}, 300_000);

test("a correctly signed bundle labelled with another commit fails the build", () => {
  const r = buildImage(`${IMAGE}-mislabelled`, bundle.dir, { commit: "fedcba9", sha256: bundle.sha256 });
  tryDocker(["rmi", "-f", `${IMAGE}-mislabelled`]);
  expect(r.code).not.toBe(0);
  expect(r.out).toContain(`web bundle refused: the bundle context holds no robotmoney-web-${SITE_VERSION.version}-fedcba9.tar.gz`);
}, 300_000);

test("a correctly signed bundle that carries a hardlink fails the build", () => {
  // GNU tar stores the second name of a hardlinked file as a link entry. The
  // packer never writes one, so the tarball is made by hand and then signed by
  // the key the server image trusts: only the verifier's own checks stand
  // between it and the served root.
  const site = join(work, "hardlink-site");
  for (const [rel, body] of Object.entries(SITE_FILES)) {
    mkdirSync(dirname(join(site, rel)), { recursive: true });
    writeFileSync(join(site, rel), body);
  }
  execFileSync("ln", [join(site, "index.html"), join(site, "linked.html")]);
  const dir = join(work, "hardlink-bundle");
  mkdirSync(dir, { recursive: true });
  const name = bundleFileName(SITE_VERSION);
  execFileSync("tar", ["-C", site, "-czf", join(dir, name), ...Object.keys(SITE_FILES), "linked.html"]);
  expect(execFileSync("tar", ["-tvzf", join(dir, name)]).toString()).toMatch(/^h|link to/m);
  const sha256 = createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");
  writeFileSync(join(dir, `${name}.sha256`), digestStatement(sha256, name));
  signBundle(join(dir, name), signerKey);
  const r = buildImage(`${IMAGE}-hardlink`, dir, { commit: SITE_VERSION.commit, sha256 });
  tryDocker(["rmi", "-f", `${IMAGE}-hardlink`]);
  expect(r.code).not.toBe(0);
  expect(r.out).toContain("web bundle refused: the tarball holds a link");
}, 300_000);
