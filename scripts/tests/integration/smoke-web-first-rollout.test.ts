// A host's first image swap, from nginx, against real Docker (issue 1632,
// docs/technical/web-serving-architecture.md §4, the first-rollout rule). The
// host is this machine (smoke-web-image-harness.ts with `firstServer:
// "nginx"`): the nginx website-server serving a web/ directory, as every host
// runs before its first `bun smoke:web --host`.
//
// In order, each against the state the one before left:
//
//   forced failure  a first swap whose public check fails returns to the
//                   running nginx container: the same container, its own
//                   image, its own site; no site image is kept;
//   first swap      a first swap that passes keeps the nginx container,
//                   stopped, as the rollback target; no `-previous` image;
//   restart         `docker restart` of the site container serves the same
//                   release again (R4, §4: a container that restarts serves
//                   the same image);
//   rollback        `--rollback` starts the kept nginx container again; the
//                   site image becomes the one previous image, and no
//                   `-current` remains, so a platform boot runs nginx again;
//   forward again   `--rollback` from nginx swaps the previous site image back
//                   in, as a first swap again.
//
// LOUD, NEVER SKIPPED: Docker and ssh-keygen are hard dependencies.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { deployImage, FIRST_ROLLOUT_SUFFIX, GAP_LIMIT_MS, readImageReceipt, rollbackImage, siteImageTag, type ImageReceipt } from "../../lib/website-release.ts";
import { createImageHost, docker, waitServed, type ImageHost } from "./smoke-web-image-harness.ts";

const V0 = { version: "0.9.0", commit: "0000nnn" };
const V1 = { version: "1.0.0", commit: "1111aaa" };

let h: ImageHost;
let nginx: { id: string; name: string; image: string; port: number };

/** The instance's website-server containers, running or not: name → image. */
function containers(): Record<string, string> {
  const ids = docker(["ps", "-aq", "--no-trunc", "--filter", `label=robotmoney.instance=${h.instance}`, "--filter", "label=com.docker.compose.service=website-server"])
    .split("\n")
    .filter((l) => l !== "");
  return Object.fromEntries(ids.map((id) => docker(["inspect", "--format", "{{.Name}}|{{.Image}}|{{.State.Status}}", id]).split("|")).map(([n, i, s]) => [`${n!.replace(/^\//, "")} ${s}`, i!]));
}

async function run(fn: (deps: ReturnType<ImageHost["deps"]>) => Promise<ImageReceipt>, extra: Parameters<ImageHost["deps"]>[0] = {}) {
  const deps = h.deps(extra);
  try {
    return { receipt: await fn(deps), error: null as Error | null };
  } catch (error) {
    return { receipt: readImageReceipt(deps.receiptDir)!, error: error as Error };
  }
}

beforeAll(async () => {
  h = createImageHost("first-rollout", V0, { firstServer: "nginx" });
  await waitServed(h, V0);
  nginx = h.serving();
}, 600_000);

afterAll(() => h?.dispose(), 120_000);

test("a forced failure on the first swap returns to the running nginx container", async () => {
  const wrongOrigin = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ version: "9.9.9", commit: "deadbee" }) });
  try {
    const { receipt, error } = await run((deps) => deployImage({ bundle: h.bundle(V1), serverImage: h.serverImage }, deps), { publicOrigin: `http://127.0.0.1:${wrongOrigin.port}` });
    console.log(`smoke-web-first-rollout forced failure: gap ${receipt.gap?.ms} ms, revert gap ${receipt.revertGap?.ms} ms`);
    expect(error?.message).toMatch(/The swap to web-v1\.0\.0 failed: .*The previous website-server was started again\./);
    expect(receipt.outcome).toBe("reverted");
    expect(receipt.oldContainer).toEqual({ id: nginx.id, image: nginx.image });
    expect(receipt.checks.find((c) => c.name === "revert")).toMatchObject({ ok: true });
    expect(receipt.revertGap!.ms!).toBeLessThanOrEqual(GAP_LIMIT_MS);
  } finally {
    wrongOrigin.stop(true);
  }
  await waitServed(h, V0, 1_000);
  const after = h.serving();
  expect([after.id, after.name, after.image, after.port]).toEqual([nginx.id, nginx.name, nginx.image, nginx.port]);
  // Nothing of the failed swap is kept: no site image, no tag, no other container.
  expect(h.instanceImages()).toEqual([]);
  expect([h.imageId(siteImageTag(h.instance, "current")), h.imageId(siteImageTag(h.instance, "previous"))]).toEqual([null, null]);
  expect(containers()).toEqual({ [`${nginx.name} running`]: nginx.image });
}, 300_000);

test("the first swap keeps the stopped nginx container as the rollback target, and no previous image", async () => {
  const { receipt, error } = await run((deps) => deployImage({ bundle: h.bundle(V1), serverImage: h.serverImage }, deps));
  expect(error).toBeNull();
  console.log(`smoke-web-first-rollout first swap: gap ${receipt.gap?.ms} ms`);
  expect(receipt).toMatchObject({ outcome: "swapped", oldContainer: { id: nginx.id, image: nginx.image }, previousImage: null });
  await waitServed(h, V1, 1_000);
  const site = h.serving();
  expect([site.name, site.port]).toEqual([nginx.name, nginx.port]);
  expect(h.imageId(siteImageTag(h.instance, "current"))).toBe(site.image);
  expect(h.imageId(siteImageTag(h.instance, "previous"))).toBeNull();
  expect(containers()).toEqual({ [`${nginx.name} running`]: site.image, [`${nginx.name}${FIRST_ROLLOUT_SUFFIX} exited`]: nginx.image });
}, 300_000);

test("after docker restart of the site container, /version.json names the same release", async () => {
  const before = h.serving();
  docker(["restart", "-t", "5", before.id]);
  await waitServed(h, V1, 30_000);
  const after = h.serving();
  console.log(`smoke-web-first-rollout restart: ${before.id.slice(0, 12)} serves web-v${V1.version} again`);
  expect([after.id, after.image, after.port]).toEqual([before.id, before.image, before.port]);
  expect(after.startedAt).not.toBe(before.startedAt);
  // The served root still equals the image (R4).
  expect(docker(["diff", after.id]).split("\n").filter((l) => /\s\/srv\/web(\/|$)/.test(l))).toEqual([]);
}, 120_000);

test("--rollback starts the kept nginx container again, and the site image becomes the one previous image", async () => {
  const site = h.serving();
  const { receipt, error } = await run((deps) => rollbackImage(deps));
  expect(error).toBeNull();
  console.log(`smoke-web-first-rollout rollback: gap ${receipt.gap?.ms} ms`);
  expect(receipt).toMatchObject({ action: "rollback", outcome: "swapped", release: { ...V0 }, newContainer: { id: nginx.id, image: nginx.image }, previousImage: site.image });
  expect(receipt.gap!.ms!).toBeLessThanOrEqual(GAP_LIMIT_MS);
  await waitServed(h, V0, 1_000);
  const after = h.serving();
  expect([after.id, after.name, after.port]).toEqual([nginx.id, nginx.name, nginx.port]);
  // No -current: a platform boot (stack.ts) runs nginx from docker-compose.yml again.
  expect(h.imageId(siteImageTag(h.instance, "current"))).toBeNull();
  expect(h.imageId(siteImageTag(h.instance, "previous"))).toBe(site.image);
  expect(containers()).toEqual({ [`${nginx.name} running`]: nginx.image });
}, 300_000);

test("--rollback from nginx swaps the previous site image back in, keeping nginx as the rollback target again", async () => {
  const previous = h.imageId(siteImageTag(h.instance, "previous"))!;
  const { receipt, error } = await run((deps) => rollbackImage(deps));
  expect(error).toBeNull();
  expect(receipt).toMatchObject({ action: "rollback", outcome: "swapped", release: { ...V1 }, currentImage: previous, previousImage: null });
  await waitServed(h, V1, 1_000);
  expect(h.serving().image).toBe(previous);
  expect(containers()).toEqual({ [`${nginx.name} running`]: previous, [`${nginx.name}${FIRST_ROLLOUT_SUFFIX} exited`]: nginx.image });
}, 300_000);
