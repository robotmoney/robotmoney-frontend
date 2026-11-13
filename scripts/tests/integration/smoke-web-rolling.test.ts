// Swapping the site image under live traffic (issue 1628,
// docs/technical/web-serving-architecture.md §4.1). Real Docker on this
// machine (smoke-web-image-harness.ts).
//
// A probe sends 10 requests a second to the public port, each on its own
// clock, for the whole run: /version.json and, proxied to the stand-in api,
// /api/version, alternately. Meanwhile `bun smoke:web`'s image mode runs four
// swaps in a row: deploy a second bundle, roll back, roll back again, deploy a
// third bundle.
//
// Graded:
//   - every swap's gap, rollbacks included, is under the 3 second limit;
//   - no request fails outside a gap the receipts recorded. A failed request
//     whose time in flight overlaps no recorded gap fails the test;
//   - after every swap the instance holds exactly two site images, the current
//     one and one previous one, and the previous one is the image that served
//     before that swap;
//   - the probe saw every version it should have, so it overlapped the swaps.
//
// The test prints `smoke-web-rolling: ...` with the counts, which
// integration.yml greps so a skipped run is never green.
//
// LOUD, NEVER SKIPPED: Docker and ssh-keygen are hard dependencies.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { deployImage, GAP_LIMIT_MS, rollbackImage, siteImageTag, type ImageReceipt, type SwapGap } from "../../lib/website-release.ts";
import { createImageHost, waitServed, type ImageHost } from "./smoke-web-image-harness.ts";

const V1 = { version: "2.0.0", commit: "aaaa001" };
const V2 = { version: "2.1.0", commit: "bbbb002" };
const V3 = { version: "2.2.0", commit: "cccc003" };
const RATE_PER_SECOND = 10;

interface Probe {
  readonly path: string;
  readonly sent: number;
  done: number;
  ok: boolean;
  version: string | null;
}

let h: ImageHost;
const probes: Probe[] = [];
const gaps: { op: string; gap: SwapGap }[] = [];
const steps: { op: string; receipt: ImageReceipt; servedBefore: string; images: string[]; previous: string | null; current: string | null }[] = [];

beforeAll(async () => {
  h = createImageHost("rolling", V1);
  await waitServed(h, V1);
  const port = h.serving().port;
  let stop = false;
  let n = 0;
  const timer = setInterval(() => {
    if (stop) return;
    const path = n++ % 2 === 0 ? "/version.json" : "/api/version";
    const probe: Probe = { path, sent: Date.now(), done: 0, ok: false, version: null };
    probes.push(probe);
    fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(2_000) })
      .then(async (res) => {
        const body = (await res.json()) as { version?: string; api?: string };
        probe.ok = res.ok && (path === "/api/version" ? typeof body.api === "string" : typeof body.version === "string");
        probe.version = body.version ?? null;
      })
      .catch(() => {
        probe.ok = false;
      })
      .finally(() => {
        probe.done = Date.now();
      });
  }, 1_000 / RATE_PER_SECOND);

  try {
    await Bun.sleep(1_000);
    const ops: [string, () => Promise<ImageReceipt>][] = [
      ["deploy 2.1.0", () => deployImage({ bundle: h.bundle(V2), serverImage: h.serverImage }, h.deps())],
      ["rollback to 2.0.0", () => rollbackImage(h.deps())],
      ["rollback to 2.1.0", () => rollbackImage(h.deps())],
      ["deploy 2.2.0", () => deployImage({ bundle: h.bundle(V3), serverImage: h.serverImage }, h.deps())],
    ];
    for (const [op, run] of ops) {
      const servedBefore = h.serving().image;
      const receipt = await run();
      if (receipt.gap) gaps.push({ op, gap: receipt.gap });
      if (receipt.revertGap) gaps.push({ op: `${op} (revert)`, gap: receipt.revertGap });
      steps.push({
        op,
        receipt,
        servedBefore,
        images: h.instanceImages(),
        previous: h.imageId(siteImageTag(h.instance, "previous")),
        current: h.imageId(siteImageTag(h.instance, "current")),
      });
      await Bun.sleep(700);
    }
  } finally {
    stop = true;
    clearInterval(timer);
    // Let the last requests finish.
    await Bun.sleep(2_500);
  }
}, 900_000);

afterAll(() => h?.dispose(), 120_000);

test("four swaps in a row each finish, each with a gap under the 3 second limit, rollbacks included", () => {
  expect(steps.map((s) => [s.op, s.receipt.outcome])).toEqual([
    ["deploy 2.1.0", "swapped"],
    ["rollback to 2.0.0", "swapped"],
    ["rollback to 2.1.0", "swapped"],
    ["deploy 2.2.0", "swapped"],
  ]);
  for (const s of steps) {
    expect({ op: s.op, ms: s.receipt.gap?.ms, within: (s.receipt.gap?.ms ?? Infinity) <= GAP_LIMIT_MS }).toEqual({ op: s.op, ms: s.receipt.gap!.ms, within: true });
  }
  expect(steps.map((s) => s.receipt.release?.version)).toEqual(["2.1.0", "2.0.0", "2.1.0", "2.2.0"]);
});

test("four swaps and rollbacks in a row keep exactly one previous image: the one that served before the swap", () => {
  for (const s of steps) {
    expect({ op: s.op, count: s.images.length }).toEqual({ op: s.op, count: 2 });
    expect({ op: s.op, previous: s.previous }).toEqual({ op: s.op, previous: s.servedBefore });
    expect({ op: s.op, current: s.current }).toEqual({ op: s.op, current: s.receipt.newContainer!.image });
    expect(s.images).toEqual([s.previous!, s.current!].sort());
  }
});

test("under a 10 requests per second probe, no request fails outside the gaps the receipts recorded", () => {
  const windows = gaps.map(({ gap }) => [Date.parse(gap.startedAt), gap.endedAt === null ? Infinity : Date.parse(gap.endedAt)] as const);
  const failed = probes.filter((p) => !p.ok);
  const outside = failed.filter((p) => !windows.some(([start, end]) => p.sent <= end && p.done >= start));
  const versions = new Set(probes.map((p) => p.version).filter((v) => v !== null));
  const span = (probes.at(-1)!.sent - probes[0]!.sent) / 1_000;
  console.log(
    `smoke-web-rolling: ${probes.length} requests over ${span.toFixed(1)} s, ${failed.length} failed, ${outside.length} outside a gap; ` +
      `gaps ${gaps.map((g) => `${g.op}=${g.gap.ms}ms`).join(", ")}`,
  );
  expect(outside.map((p) => ({ path: p.path, sent: new Date(p.sent).toISOString(), done: new Date(p.done).toISOString() }))).toEqual([]);
  // The probe ran at the rate, through every swap, and saw each version served.
  expect(probes.length).toBeGreaterThanOrEqual(Math.floor(span * RATE_PER_SECOND * 0.9));
  expect(probes.every((p) => p.done > 0)).toBe(true);
  expect([...versions].sort()).toEqual(["2.0.0", "2.1.0", "2.2.0"]);
  expect(gaps.length).toBe(4);
});
