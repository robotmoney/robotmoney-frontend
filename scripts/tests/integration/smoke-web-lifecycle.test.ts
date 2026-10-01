// `bun smoke:web` against a REAL running stack (issue #1026 W7, criterion 161;
// smoke spec §13.2, D54).
//
// One `bun smoke --local blank --migrate` boot of its own instance, then
// `bun smoke:web` run as an operator runs it, as its own process, and graded
// on what the running stack and the instance directory say afterwards:
//
//   deploy     a second site version (a copy of this checkout with another
//              frontend version, smoke-web-harness.ts) lands in
//              web/<version>-<commit>/ under the instance state directory, and
//              website-server serves it: /version.json through its published
//              port reports the new version;
//   refusal    a site whose range excludes the running API (^9.0.0 against
//              contract 0.2.0) refuses naming both, and nothing moves: the
//              served site, `current`, the receipt, and no directory for it;
//   rollback   `--rollback` returns website-server to the previous site;
//   records    the web journal and receipt read back with the plan ids and
//              steps each run wrote; the stack's own deployment journal and
//              receipt are byte-for-byte unchanged;
//   no restart `api`, every worker and website-server itself keep their
//              container id and start time across all of it: the switch is an
//              nginx reload, never a restart.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readContractVersion } from "../../lib/api-range.ts";
import { currentSite, previousSite } from "../../lib/smoke-site.ts";
import { readStackState } from "../../lib/smoke-state.ts";
import { readWebJournal, readWebReceipt, type WebReceipt } from "../../lib/website-release.ts";
import { BOOT_TIMEOUT_MS, bootFailureReport, harness, spawnBoot, teardown, type BootHarness, type RunningBoot } from "./smoke-boot-harness.ts";
import {
  containerChanges,
  servedSite,
  serviceContainers,
  smokeWeb,
  variantTree,
  type ServiceContainer,
  type VariantTree,
} from "./smoke-web-harness.ts";

const API_VERSION = readContractVersion();

let h: BootHarness;
let boot: RunningBoot;
let webPort = 0;
let bootSite: string | null = null;
let stackJournal = "";
let stackReceipt = "";
let before: Record<string, ServiceContainer> = {};
let inRange: VariantTree;
let outOfRange: VariantTree;

let deploy = { code: -1, out: "" };
let afterDeploy: { current: string | null; previous: string | null; served: string; receipt: WebReceipt | null } | null = null;
let refusal = { code: -1, out: "" };
let afterRefusal: { current: string | null; served: string; receipt: WebReceipt | null; dirExists: boolean } | null = null;
let rollback = { code: -1, out: "" };
let afterRollback: { current: string | null; previous: string | null; served: string; receipt: WebReceipt | null } | null = null;
let after: Record<string, ServiceContainer> = {};

const served = async () => {
  const site = await servedSite(webPort);
  return `${site.version}-${site.commit}`;
};

beforeAll(async () => {
  h = harness("smokeweb");
  boot = spawnBoot(h);
  const code = await boot.exited;
  if (code !== 0) throw new Error(`bun smoke exited ${code}:\n${bootFailureReport(boot)}`);
  webPort = readStackState(h.paths)!.webPort;
  bootSite = currentSite(h.paths.webDir);
  stackJournal = readFileSync(h.paths.journalFile, "utf8");
  stackReceipt = readFileSync(h.paths.receiptFile, "utf8");

  inRange = variantTree("0.1.9-webdeploy", `^${API_VERSION}`);
  outOfRange = variantTree("0.1.9-webrefused", "^9.0.0");
  before = serviceContainers(h.project);

  deploy = await smokeWeb(h, [], inRange.dir);
  afterDeploy = {
    current: currentSite(h.paths.webDir),
    previous: previousSite(h.paths.webDir),
    served: await served(),
    receipt: readWebReceipt(h.paths),
  };

  refusal = await smokeWeb(h, [], outOfRange.dir);
  afterRefusal = {
    current: currentSite(h.paths.webDir),
    served: await served(),
    receipt: readWebReceipt(h.paths),
    dirExists: existsSync(join(h.paths.webDir, outOfRange.siteId)),
  };

  rollback = await smokeWeb(h, ["--rollback"]);
  afterRollback = {
    current: currentSite(h.paths.webDir),
    previous: previousSite(h.paths.webDir),
    served: await served(),
    receipt: readWebReceipt(h.paths),
  };
  after = serviceContainers(h.project);
}, BOOT_TIMEOUT_MS);

afterAll(() => {
  if (h) teardown(h, boot);
  inRange?.dispose();
  outOfRange?.dispose();
}, 300_000);

describe("bun smoke:web deploys a site version onto a running stack", () => {
  test("the boot placed a site, and it declares a range the running API is inside", async () => {
    expect(bootSite).not.toBeNull();
    const site = await servedSite(webPort);
    expect(site.apiRange).toBe(`^${API_VERSION}`);
    const api = (await (await fetch(`http://127.0.0.1:${webPort}/api/version`)).json()) as { api: string };
    expect(api.api).toBe(API_VERSION);
  });

  test("it builds into web/<version>-<commit>/ under the instance state directory and switches website-server to it", () => {
    expect(deploy.code, deploy.out).toBe(0);
    expect(existsSync(join(h.paths.webDir, inRange.siteId, "index.html"))).toBe(true);
    expect(afterDeploy).toMatchObject({ current: inRange.siteId, previous: bootSite, served: inRange.siteId });
    expect(afterDeploy!.receipt).toMatchObject({
      action: "deploy",
      instance: h.instance,
      siteId: inRange.siteId,
      previous: bootSite,
      swapped: true,
      reloaded: true,
      apiVersion: API_VERSION,
      apiRange: `^${API_VERSION}`,
    });
  });

  test("a site whose range excludes the running API is refused naming both, and nothing moves", () => {
    expect(refusal.code).not.toBe(0);
    expect(refusal.out).toContain(`running API is ${API_VERSION}, outside site ${outOfRange.siteId}'s range ^9.0.0`);
    expect(afterRefusal).toEqual({ current: inRange.siteId, served: inRange.siteId, receipt: afterDeploy!.receipt, dirExists: false });
  });

  test("--rollback returns website-server to the previous directory", () => {
    expect(rollback.code, rollback.out).toBe(0);
    expect(afterRollback).toMatchObject({ current: bootSite, previous: inRange.siteId, served: bootSite });
    expect(afterRollback!.receipt).toMatchObject({ action: "rollback", siteId: bootSite, previous: inRange.siteId, swapped: true, reloaded: true });
  });

  test("the web journal reads back every run under its plan id: deploy, refusal, rollback", () => {
    const journal = readWebJournal(h.paths);
    const byPlan = (planId: string) => journal.filter((e) => e.planId === planId).map((e) => e.step);
    expect(byPlan(afterDeploy!.receipt!.planId)).toEqual(["begin", "range-checked", "built", "switched", "reloaded", "done"]);
    expect(byPlan(afterRollback!.receipt!.planId)).toEqual(["begin", "range-checked", "switched", "reloaded", "done"]);
    const refused = journal.filter((e) => e.step === "refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]!.detail).toMatchObject({ apiVersion: API_VERSION, apiRange: "^9.0.0" });
  });

  test("the stack's own deployment journal and receipt are untouched", () => {
    expect(readFileSync(h.paths.journalFile, "utf8")).toBe(stackJournal);
    expect(readFileSync(h.paths.receiptFile, "utf8")).toBe(stackReceipt);
  });

  test("api, every worker and website-server keep their container and start time: a reload, never a restart", () => {
    for (const service of ["api", "website-server", "worker-analytics"]) expect(Object.keys(before)).toContain(service);
    const { changes, restartingBefore } = containerChanges(before, after);
    // The relaxation for a service already crash-looping never covers these.
    for (const steady of Object.keys(before).filter((s) => s === "api" || s === "website-server" || s.startsWith("worker-"))) {
      expect(restartingBefore).not.toContain(steady);
    }
    if (restartingBefore.length > 0) console.warn(`[smoke-web-lifecycle] already restarting before smoke:web (id compared only): ${restartingBefore.join(", ")}`);
    expect(changes).toEqual([]);
  });
});
