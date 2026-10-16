// Rolling the site under live traffic (issue #1026 W7, criterion 164; smoke
// spec §13.2, D54): switching the site between two versions while the API
// serves traffic fails no request, and restarts no container.
//
// A real `bun smoke --local blank --migrate` stack of its own instance. Steady
// traffic goes through website-server's published port, the way a visitor's
// browser reaches it: a prerendered page, a client route that falls back to
// the shell, the site's /version.json, and — proxied to `api` — /api/version,
// /health and one read route the home page loads. Meanwhile `bun smoke:web`
// switches to a second built version, rolls back, switches to it again and
// rolls back again: four nginx reloads mid-traffic.
//
// Graded: zero failed requests (every response 2xx, no connection error), both
// site versions actually served during the run (so the traffic overlapped the
// switches rather than finishing before them), and the `api` container — and
// every worker's and website-server's — has the same id and start time after.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readContractVersion } from "../../lib/api-range.ts";
import { currentSite } from "../../lib/smoke-site.ts";
import { readStackState } from "../../lib/smoke-state.ts";
import { BOOT_TIMEOUT_MS, bootFailureReport, harness, spawnBoot, teardown, type BootHarness, type RunningBoot } from "./smoke-boot-harness.ts";
import { containerChanges, serviceContainers, smokeWeb, variantTree, type ServiceContainer, type VariantTree } from "./smoke-web-harness.ts";

const API_VERSION = readContractVersion();
/** Concurrent request loops; each issues its next request as soon as the last answers. */
const LOOPS = 6;
const PATHS = ["/", "/swarm/members/not-prerendered", "/version.json", "/api/version", "/health", "/api/dashboards/allocation"] as const;

let h: BootHarness;
let boot: RunningBoot;
let second: VariantTree;
let bootSite: string | null = null;
let before: Record<string, ServiceContainer> = {};
let after: Record<string, ServiceContainer> = {};
const runs: { args: string[]; code: number; out: string }[] = [];
const failures: string[] = [];
const servedVersions = new Set<string>();
const perPath = new Map<string, number>();
let total = 0;

beforeAll(async () => {
  h = harness("smokewebroll");
  boot = spawnBoot(h);
  const code = await boot.exited;
  if (code !== 0) throw new Error(`bun smoke exited ${code}:\n${bootFailureReport(boot)}`);
  const webPort = readStackState(h.paths)!.webPort;
  bootSite = currentSite(h.paths.webDir);
  second = variantTree("0.1.9-webroll", `^${API_VERSION}`);
  before = serviceContainers(h.project);

  let stop = false;
  const loop = async (offset: number) => {
    for (let i = offset; !stop; i++) {
      const path = PATHS[i % PATHS.length]!;
      total++;
      perPath.set(path, (perPath.get(path) ?? 0) + 1);
      try {
        const res = await fetch(`http://127.0.0.1:${webPort}${path}`);
        const body = await res.text();
        if (res.status < 200 || res.status > 299) failures.push(`${path}: HTTP ${res.status} ${body.slice(0, 120)}`);
        else if (path === "/version.json") servedVersions.add((JSON.parse(body) as { version: string }).version);
      } catch (error) {
        failures.push(`${path}: ${(error as Error).message}`);
      }
    }
  };
  const loops = Array.from({ length: LOOPS }, (_, i) => loop(i));
  // Traffic first, then the switches, then traffic after the last one.
  await Bun.sleep(1_000);
  for (const [args, tree] of [[[], second.dir], [["--rollback"], undefined], [[], second.dir], [["--rollback"], undefined]] as const) {
    const r = await smokeWeb(h, args, tree);
    runs.push({ args: [...args], ...r });
  }
  await Bun.sleep(1_000);
  stop = true;
  await Promise.all(loops);
  after = serviceContainers(h.project);
}, BOOT_TIMEOUT_MS);

afterAll(() => {
  if (h) teardown(h, boot);
  second?.dispose();
}, 300_000);

test("all four switches ran, and each one switched", () => {
  expect(runs.map((r) => [r.args.join(" "), r.code])).toEqual([["", 0], ["--rollback", 0], ["", 0], ["--rollback", 0]]);
  for (const r of runs) expect(r.out).toMatch(/\[smoke:web\] now serving /);
  expect(currentSite(h.paths.webDir)).toBe(bootSite);
});

test("the traffic overlapped the switches: both site versions were served, on every path", () => {
  const bootVersion = (JSON.parse(readFileSync(join(h.paths.webDir, bootSite!, "version.json"), "utf8")) as { version: string }).version;
  expect(bootVersion).not.toBe(second.version);
  expect(servedVersions).toEqual(new Set([bootVersion, second.version]));
  for (const path of PATHS) expect(perPath.get(path) ?? 0).toBeGreaterThan(20);
});

test("zero failed requests: no non-2xx answer and no connection error", () => {
  expect(total).toBeGreaterThan(500);
  expect(failures).toEqual([]);
});

test("the api container is unchanged, and no worker or website-server restarted", () => {
  expect(after.api?.id).toBe(before.api!.id);
  const { changes, restartingBefore } = containerChanges(before, after);
  for (const steady of Object.keys(before).filter((s) => s === "api" || s === "website-server" || s.startsWith("worker-"))) {
    expect(restartingBefore).not.toContain(steady);
  }
  if (restartingBefore.length > 0) console.warn(`[smoke-web-rolling] already restarting before the roll (id compared only): ${restartingBefore.join(", ")}`);
  expect(changes).toEqual([]);
});
