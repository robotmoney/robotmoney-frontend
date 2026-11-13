// `bun smoke:web` image mode against real Docker (issue 1628,
// docs/technical/web-serving-architecture.md §4). The host is this machine
// (smoke-web-image-harness.ts): a server image trusting a key made here, a
// stand-in api, and a running website-server built from a first signed bundle.
//
// In order, each against the state the one before left:
//
//   deploy      a second bundle swaps in: the public port now names it, the new
//               container keeps the old one's name and host port, the throwaway
//               copy ran on another port, and the first image is the one
//               previous image. An active maintenance.json, written by
//               scripts/release/maintenance.ts into the tmpfs, is carried over;
//   bad copy    a bundle whose copy fails its check never reaches the public
//               port: the serving container is untouched and nothing was stopped;
//   host trust  a bundle the control machine trusts but the server image does
//               not fails verification on the host and is never built;
//   bad public  a failed public check starts the previous container again,
//               fails with a non-zero result, and records the revert's gap;
//   by name     `--bundle web-v<first>` fetched from its release deploys the
//               older bundle with the same checks;
//   CLI         `bun smoke:web --host local --instance <i> --rollback`, run as
//               an operator runs it, returns to the previous image.
//
// LOUD, NEVER SKIPPED: Docker and ssh-keygen are hard dependencies.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MAINTENANCE_FILE } from "../../lib/maintenance-file.ts";
import { WEBSITE_MAINTENANCE_DIR } from "../../lib/website-image.ts";
import { deployImage, GAP_LIMIT_MS, readImageReceipt, siteImageTag, type ImageReceipt } from "../../lib/website-release.ts";
import { createImageHost, docker, repoRoot, waitServed, type ImageHost } from "./smoke-web-image-harness.ts";

const V1 = { version: "1.0.0", commit: "1111aaa" };
const V2 = { version: "1.1.0", commit: "2222bbb" };
const V3 = { version: "1.2.0", commit: "3333ccc" };

let h: ImageHost;
let v1Bundle = "";
let v1Image = "";

/** A deploy that resolves to its receipt, or to the receipt it wrote before it threw. */
async function deploy(bundle: string, extra: Parameters<ImageHost["deps"]>[0] = {}): Promise<{ receipt: ImageReceipt; error: Error | null; deps: ReturnType<ImageHost["deps"]> }> {
  const deps = h.deps(extra);
  try {
    return { receipt: await deployImage({ bundle, serverImage: h.serverImage }, deps), error: null, deps };
  } catch (error) {
    return { receipt: readImageReceipt(deps.receiptDir)!, error: error as Error, deps };
  }
}

beforeAll(async () => {
  h = createImageHost("lifecycle", V1);
  await waitServed(h, V1);
  v1Image = h.serving().image;
  // The release the `--bundle web-v1.0.0` case fetches.
  v1Bundle = h.bundle(V1);
}, 600_000);

afterAll(() => h?.dispose(), 120_000);

test("deploy: the new container takes the public port and the old one's name, the copy never binds it, and the first image is the one previous image", async () => {
  const before = h.serving();
  // An active maintenance window, announced into the tmpfs by the release step's own tool.
  const env = { ...process.env, RM_SMOKE_STATE_ROOT: mkdtempSync(join(tmpdir(), "rm-swt-state-")) };
  const on = Bun.spawnSync(["bun", join(repoRoot, "scripts/release/maintenance.ts"), "on", "--instance", h.instance], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(on.stdout.toString() + on.stderr.toString()).toContain(`maintenance page on in website-server ${before.id.slice(0, 12)}`);
  expect(on.exitCode).toBe(0);
  const announced = docker(["exec", before.id, "cat", `${WEBSITE_MAINTENANCE_DIR}/${MAINTENANCE_FILE}`]);
  expect(JSON.parse(announced).state).toBe("active");

  const { receipt, error } = await deploy(h.bundle(V2));
  expect(error).toBeNull();
  await waitServed(h, V2, 1_000);
  const after = h.serving();
  console.log(`smoke-web-lifecycle deploy: gap ${receipt.gap?.ms} ms, public port ${receipt.publicPort}, copy port ${receipt.copyPort}`);

  expect(receipt.outcome).toBe("swapped");
  expect(receipt.checks.every((c) => c.ok)).toBe(true);
  expect(receipt.checks.map((c) => c.name)).toEqual(["verify-local", "api-range", "verify-host", "build", "copy", "gap", "public"]);
  expect(receipt.oldContainer).toEqual({ id: before.id, image: before.image });
  expect(receipt.newContainer?.id).toBe(after.id);
  expect(after.id).not.toBe(before.id);
  expect(receipt.gap!.ms!).toBeLessThanOrEqual(GAP_LIMIT_MS);
  // The same host port, the same name; the throwaway copy had its own port.
  expect(after.port).toBe(before.port);
  expect(after.name).toBe(before.name);
  expect(receipt.publicPort).toBe(before.port);
  expect(receipt.copyPort).toBeGreaterThan(0);
  expect(receipt.copyPort).not.toBe(before.port);
  // The new container runs as the overlay says, with the old one's restart policy and healthcheck.
  const hc = JSON.parse(docker(["inspect", "--format", "{{json .HostConfig}}", after.id])) as { ReadonlyRootfs: boolean; CapDrop: string[]; RestartPolicy: { Name: string } };
  expect([hc.ReadonlyRootfs, hc.CapDrop, hc.RestartPolicy.Name]).toEqual([true, ["ALL"], "unless-stopped"]);
  expect(docker(["inspect", "--format", "{{json .Config.Healthcheck.Test}}", after.id])).toContain("wget -q -O /dev/null http://127.0.0.1:8080/");
  // Exactly one previous image: the first one.
  expect(h.imageId(siteImageTag(h.instance, "previous"))).toBe(v1Image);
  expect(h.imageId(siteImageTag(h.instance, "current"))).toBe(after.image);
  expect(h.instanceImages()).toEqual([v1Image, after.image].sort());
  // The maintenance window survived the swap, which wiped the old tmpfs.
  expect(docker(["exec", after.id, "cat", `${WEBSITE_MAINTENANCE_DIR}/${MAINTENANCE_FILE}`])).toBe(announced);
  const off = Bun.spawnSync(["bun", join(repoRoot, "scripts/release/maintenance.ts"), "off", "--instance", h.instance], { env, stdout: "pipe", stderr: "pipe" });
  expect(off.exitCode).toBe(0);
  expect(() => docker(["exec", after.id, "cat", `${WEBSITE_MAINTENANCE_DIR}/${MAINTENANCE_FILE}`])).toThrow();
}, 300_000);

test("a throwaway copy that fails its check never takes the public port", async () => {
  const before = h.serving();
  const images = h.instanceImages();
  const { receipt, error, deps } = await deploy(h.bundle({ ...V3, broken: true }));
  expect(error?.message).toMatch(/throwaway copy of web-v1\.2\.0 failed its check/);
  expect(receipt).toMatchObject({ outcome: "refused", newContainer: null, gap: null });
  expect(receipt.checks.find((c) => c.name === "copy")).toMatchObject({ ok: false });
  // Nothing on the public port moved: the same container, never restarted, still serving V2.
  const after = h.serving();
  expect([after.id, after.startedAt]).toEqual([before.id, before.startedAt]);
  await waitServed(h, V2, 1_000);
  const sent = (deps.host.commands as string[][]).map((c) => c.join(" "));
  expect(sent.filter((l) => /^docker (create|stop|start)\b/.test(l))).toEqual([]);
  // The candidate that never served is gone: the host keeps one previous image.
  expect(h.instanceImages()).toEqual(images);
}, 300_000);

test("a bundle the server image does not trust fails verification on the host and is never built", async () => {
  // The control machine trusts the rogue key too, so only the host's check stands in the way.
  const rogue = h.rogueKey();
  const bundle = h.bundle(V3, rogue);
  const signers = join(h.work, "allowed-signers-with-rogue");
  const pub = (await Bun.file(`${rogue}.pub`).text()).trim().split(/\s+/).slice(0, 2).join(" ");
  await Bun.write(signers, `${await Bun.file(h.allowedSigners).text()}rogue namespaces="robotmoney-web-bundle@v1" ${pub}\n`);
  const { receipt, error, deps } = await deploy(bundle, { allowedSigners: signers });
  expect(error?.message).toMatch(/failed verification on local: web bundle refused: no key in \/etc\/robotmoney\/allowed-signers signed/);
  expect(receipt.checks.map((c) => [c.name, c.ok])).toEqual([["verify-local", true], ["api-range", true], ["verify-host", false]]);
  const sent = (deps.host.commands as string[][]).map((c) => c.join(" "));
  expect(sent.some((l) => l.includes("rm-verify-web-bundle"))).toBe(true);
  expect(sent.filter((l) => /^docker build\b/.test(l))).toEqual([]);
  await waitServed(h, V2, 1_000);
}, 300_000);

test("a failed public check starts the previous container again and exits non-zero", async () => {
  const before = h.serving();
  const wrongOrigin = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ version: "9.9.9", commit: "deadbee" }) });
  try {
    const { receipt, error } = await deploy(h.bundle(V3), { publicOrigin: `http://127.0.0.1:${wrongOrigin.port}` });
    console.log(`smoke-web-lifecycle revert: gap ${receipt.gap?.ms} ms, revert gap ${receipt.revertGap?.ms} ms`);
    expect(error?.message).toMatch(/The swap to web-v1\.2\.0 failed: .*does not name web-v1\.2\.0\. The previous website-server was started again\./);
    expect(receipt.outcome).toBe("reverted");
    expect(receipt.checks.find((c) => c.name === "public")).toMatchObject({ ok: false });
    expect(receipt.checks.find((c) => c.name === "revert")).toMatchObject({ ok: true });
    expect(receipt.revertGap!.ms!).toBeLessThanOrEqual(GAP_LIMIT_MS);
  } finally {
    wrongOrigin.stop(true);
  }
  // The previous container serves V2 again, on the same port; the V3 container and image are gone.
  await waitServed(h, V2, 1_000);
  const after = h.serving();
  expect([after.id, after.port]).toEqual([before.id, before.port]);
  expect(h.imageId(siteImageTag(h.instance, "previous"))).toBe(v1Image);
  expect(h.instanceImages()).toEqual([v1Image, before.image].sort());
}, 300_000);

test("--bundle web-v1.0.0 deploys the older signed bundle by name, fetched from its release, with the same checks", async () => {
  const v2Image = h.serving().image;
  const fetched: string[] = [];
  const { receipt, error } = await deploy("web-v1.0.0", {
    async fetchRelease(tag, dir) {
      fetched.push(tag);
      for (const suffix of ["", ".sha256", ".sha256.sig"]) copyFileSync(`${v1Bundle}${suffix}`, join(dir, `${basename(v1Bundle)}${suffix}`));
    },
  });
  expect(error).toBeNull();
  expect(fetched).toEqual(["web-v1.0.0"]);
  expect(receipt.release).toMatchObject({ tag: "web-v1.0.0", ...V1 });
  expect(receipt.checks.map((c) => [c.name, c.ok])).toEqual([
    ["verify-local", true],
    ["api-range", true],
    ["verify-host", true],
    ["build", true],
    ["copy", true],
    ["gap", true],
    ["public", true],
  ]);
  await waitServed(h, V1, 1_000);
  expect(h.imageId(siteImageTag(h.instance, "previous"))).toBe(v2Image);
  expect(h.instanceImages().length).toBe(2);
}, 300_000);

test("bun smoke:web --host local --rollback, run as an operator runs it, returns to the previous image", async () => {
  const before = h.serving();
  const stateRoot = mkdtempSync(join(tmpdir(), "rm-swt-cli-"));
  const proc = Bun.spawnSync(["bun", "run", "smoke:web", "--host", "local", "--instance", h.instance, "--rollback"], {
    cwd: repoRoot,
    env: { ...process.env, RM_SMOKE_STATE_ROOT: stateRoot },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = proc.stdout.toString() + proc.stderr.toString();
  console.log(out);
  expect(proc.exitCode).toBe(0);
  expect(out).toContain("swapped: web-v1.1.0");
  await waitServed(h, V2, 1_000);
  const receipt = readImageReceipt(join(stateRoot, "web-image", h.instance))!;
  expect(receipt).toMatchObject({ action: "rollback", outcome: "swapped", oldContainer: { id: before.id } });
  expect(receipt.gap!.ms!).toBeLessThanOrEqual(GAP_LIMIT_MS);
  expect(h.serving().port).toBe(before.port);
}, 300_000);
