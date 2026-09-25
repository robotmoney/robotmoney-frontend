// `bun smoke` AND THE LIVE SITE — criterion 162 (smoke spec §13.3, D54).
//
//   "Before it replaces `api`, `bun smoke` reads the live site's
//    `/version.json`. It refuses when the new API version is outside the live
//    site's range, unless the same plan deploys a site whose range includes
//    that version. A live site with no declared range counts as outside every
//    range."
//
// Two layers. The DECISION, over real site directories on disk (the instance's
// `web/`, as scripts/lib/smoke-site.ts lays it out, and a real assembled site),
// with no Docker. Then the REAL `bun smoke` process on an instance whose live
// site is planted before the boot:
//
//   out of range, and the plan deploys no other site  → refuses before the
//                                                       first write to the
//                                                       target: no postgres, no
//                                                       lock, no migrate, live
//                                                       site kept;
//   no declared range (legacy), no other site         → refuses the same way;
//   no declared range, and the plan deploys the tree's
//   own site, whose range includes the API            → proceeds past the site
//                                                       step with `current`
//                                                       switched to it;
//   a RUNNING instance, then `--local volume --migrate`
//   with its live site out of range                   → refuses before the
//                                                       database step: the
//                                                       running api, postgres,
//                                                       ledger and manifest are
//                                                       exactly as they were.
//
// The last case is the one that matters for a real deployment: before #1026's
// fix the refusal ran at the `site` step, AFTER prepareDatabase had taken the
// lock, migrated, seeded and provisioned tokens — so a refused boot left the old
// api running against a migrated schema. Its red control is the journal: on
// that code the refused plan carries `prepare:database`, `prepare:lock` and
// `prepare:migrate` records; here it carries none.
//
// "The plan deploys no other site" is made real, not faked: the planted live
// site IS this tree's assembled site — same id, same content digest — with only
// its `/version.json` range changed, so the boot's own assembly produces the
// site already live and there is nothing new to place.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContractVersion } from "../../lib/api-range.ts";
import { siteIdOf } from "../../lib/smoke-site.ts";
import { readWebCompatPlan, webCompatRefusal } from "../../lib/smoke-web-compat.ts";
import { instancePaths } from "../../lib/smoke-state.ts";
import {
  bootFailureReport,
  bootQuery,
  BOOT_TIMEOUT_MS,
  containerIdentity,
  harness,
  journalNow,
  repoRoot,
  spawnBoot,
  teardown,
  waitFor,
  type BootHarness,
  type RunningBoot,
} from "./smoke-boot-harness.ts";

const API = readContractVersion(repoRoot);
let assembled = "";
let siteId = "";
const scratch: string[] = [];
const harnesses: { h: BootHarness; boot?: RunningBoot }[] = [];

beforeAll(() => {
  // This tree's own site, assembled exactly as a boot assembles it.
  const dir = mkdtempSync(join(tmpdir(), "rm-web-compat-asm-"));
  scratch.push(dir);
  assembled = join(dir, "site");
  const r = Bun.spawnSync(["bash", join(repoRoot, "scripts", "static-assembly.sh"), assembled], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`static assembly failed: ${r.stderr.toString()}`);
  siteId = siteIdOf(assembled);
}, 300_000);

afterAll(() => {
  for (const { h, boot } of harnesses) teardown(h, boot);
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
}, 600_000);

/**
 * Plant a live site in `webDir` and point `current` at it. `same`: a copy of
 * this tree's assembled site (same id and digest) with its range replaced;
 * otherwise a different, older site carrying `range`.
 */
function plantLive(webDir: string, opts: { same: boolean; range: string | null }): string {
  mkdirSync(webDir, { recursive: true, mode: 0o755 });
  const id = opts.same ? siteId : "0.0.9-legacy00";
  const dir = join(webDir, id);
  if (opts.same) cpSync(assembled, dir, { recursive: true });
  else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".rm-static-manifest.json"), JSON.stringify({ digest: "sha256:legacy" }));
  }
  const version = JSON.parse(opts.same ? readFileSync(join(assembled, "version.json"), "utf8") : '{"version":"0.0.9","commit":"legacy00"}');
  if (opts.range === null) delete version.apiRange;
  else version.apiRange = opts.range;
  writeFileSync(join(dir, "version.json"), JSON.stringify(version));
  symlinkSync(id, join(webDir, "current"));
  return id;
}

describe("the decision, over real site directories (no Docker)", () => {
  function webDir(): string {
    const d = mkdtempSync(join(tmpdir(), "rm-web-compat-web-"));
    scratch.push(d);
    return join(d, "web");
  }

  test("this tree's own site admits this tree's API: a fresh instance deploying it proceeds", () => {
    const plan = readWebCompatPlan(webDir(), assembled, API);
    expect(plan.live).toBeNull();
    expect(plan.deploys?.siteId).toBe(siteId);
    expect(webCompatRefusal(plan)).toBeNull();
  });

  test("an out-of-range live site that the plan would place again refuses, naming both versions", () => {
    const web = webDir();
    plantLive(web, { same: true, range: "<0.1.0" });
    const plan = readWebCompatPlan(web, assembled, API);
    expect(plan.deploys).toBeNull();
    const refusal = webCompatRefusal(plan)!;
    expect(refusal).toContain(`API version ${API}`);
    expect(refusal).toContain(`${siteId} (apiRange <0.1.0)`);
  });

  test("a live site with NO declared range is outside every range (D54)", () => {
    const web = webDir();
    plantLive(web, { same: true, range: null });
    expect(webCompatRefusal(readWebCompatPlan(web, assembled, API))).toContain("no declared range");
  });

  test("…unless the same plan deploys a site whose range includes the API", () => {
    const web = webDir();
    plantLive(web, { same: false, range: null });
    const plan = readWebCompatPlan(web, assembled, API);
    expect(plan.live?.range).toBeNull();
    expect(plan.deploys?.siteId).toBe(siteId);
    expect(webCompatRefusal(plan)).toBeNull();
  });

  test("a plan that deploys a site EXCLUDING its own API refuses, whatever the live one says", () => {
    const web = webDir();
    plantLive(web, { same: false, range: `>=${API}` });
    const other = mkdtempSync(join(tmpdir(), "rm-web-compat-other-"));
    scratch.push(other);
    const excluding = join(other, "site");
    cpSync(assembled, excluding, { recursive: true });
    const version = JSON.parse(readFileSync(join(excluding, "version.json"), "utf8"));
    writeFileSync(join(excluding, "version.json"), JSON.stringify({ ...version, apiRange: "<0.1.0" }));
    const refusal = webCompatRefusal(readWebCompatPlan(web, excluding, API));
    expect(refusal).toContain("this plan deploys");
    expect(refusal).toContain("apiRange <0.1.0");
  });
});

describe("a real `bun smoke` process against a planted live site (criterion 162)", () => {
  /** A fresh instance whose live site is planted before its first boot. */
  function instanceWithLiveSite(prefix: string, live: { same: boolean; range: string | null }) {
    const h = harness(prefix);
    const paths = instancePaths(h.root, h.instance, { create: true });
    const liveId = plantLive(paths.webDir, live);
    const slot: { h: BootHarness; boot?: RunningBoot } = { h };
    harnesses.push(slot);
    return { h, liveId, slot };
  }

  async function expectRefusedBeforeReplace(prefix: string, live: { same: boolean; range: string | null }, says: string) {
    const { h, liveId, slot } = instanceWithLiveSite(prefix, live);
    slot.boot = spawnBoot(h);
    const code = await slot.boot.exited;
    const out = slot.boot.output();
    expect({ code: code === 0 ? 0 : "non-zero" }).toEqual({ code: "non-zero" });
    expect({ refused: out.includes(`refusing to replace api: API version ${API}`), report: out.includes(says) ? "" : bootFailureReport(slot.boot) })
      .toEqual({ refused: true, report: "" });
    // Before the FIRST WRITE to the target: the refusal is the web-compat
    // record, and no database, lock, migrate, token or replace record follows
    // it. No container at all was created — not even postgres.
    const phases = (journalNow(h)?.phases ?? []).map((r) => `${r.phase}:${r.step ?? ""}:${r.status}`);
    expect(phases).toContain("prepare:web-compat:failed");
    for (const step of ["database", "lock", "bootstrap", "migrate", "seed", "tokens", "site"]) {
      expect({ step, journaled: phases.some((p) => p.startsWith(`prepare:${step}:`)) }).toEqual({ step, journaled: false });
    }
    expect(phases.some((p) => p.startsWith("replace"))).toBe(false);
    expect(Object.keys(containerIdentity(h.project))).toEqual([]);
    // The live site is still the one that was live.
    expect(readlinkSync(join(h.paths.webDir, "current"))).toBe(liveId);
  }

  test("an out-of-range live site, and a plan that deploys no other site: refused before any replace", async () => {
    await expectRefusedBeforeReplace("webcompat-out", { same: true, range: "<0.1.0" }, "apiRange <0.1.0");
  }, BOOT_TIMEOUT_MS);

  test("a legacy live site with no declared range, and no other site: refused the same way", async () => {
    await expectRefusedBeforeReplace("webcompat-legacy", { same: true, range: null }, "no declared range");
  }, BOOT_TIMEOUT_MS);

  test("a running instance, then `--local volume --migrate` with its live site out of range: refused before the database is touched", async () => {
    // 1. A blank instance with a running api on a migrated database. The boot
    //    is stopped at a boundary once its services are replaced; its
    //    containers stay up (a stopped boot tears nothing down).
    const { h, slot } = instanceWithLiveSite("webcompat-vol", { same: false, range: null });
    slot.boot = spawnBoot(h, [], { ownProcessGroup: false });
    await waitFor(
      () => (journalNow(h)?.phases ?? []).some((r) => r.phase === "replace" && r.status === "committed"),
      BOOT_TIMEOUT_MS - 120_000,
      "the first boot to replace its services",
      slot.boot,
    );
    slot.boot.proc.kill("SIGINT");
    await slot.boot.exited;
    const before = containerIdentity(h.project);
    expect({ api: before.api?.state, postgres: before.postgres?.state }).toEqual({ api: "running", postgres: "running" });
    const ledgerBefore = bootQuery(h.project, "SELECT string_agg(name, ',' ORDER BY name) FROM schema_migrations");
    const manifestBefore = bootQuery(h.project, "SELECT content_hash FROM schema_manifest");
    expect(ledgerBefore).not.toBeNull();
    expect(manifestBefore).not.toBeNull();

    // 2. The live site (this tree's own, now current) is made to exclude this
    //    tree's API. Same id and digest, so the next plan deploys no other site.
    const liveId = readlinkSync(join(h.paths.webDir, "current"));
    expect(liveId).toBe(siteId);
    const versionFile = join(h.paths.webDir, liveId, "version.json");
    writeFileSync(versionFile, JSON.stringify({ ...JSON.parse(readFileSync(versionFile, "utf8")), apiRange: "<0.1.0" }));

    // 3. `--local volume --migrate` on the same instance: refused.
    slot.boot = spawnBoot(h, [], { local: "volume" });
    const code = await slot.boot.exited;
    const out = slot.boot.output();
    expect({ code: code === 0 ? 0 : "non-zero" }).toEqual({ code: "non-zero" });
    expect({ refused: out.includes(`refusing to replace api: API version ${API}`), report: out.includes("apiRange <0.1.0") ? "" : bootFailureReport(slot.boot) })
      .toEqual({ refused: true, report: "" });
    const journal = journalNow(h)!;
    const phases = journal.phases.map((r) => `${r.phase}:${r.step ?? ""}:${r.status}`);
    expect(phases).toContain("prepare:web-compat:failed");
    for (const step of ["database", "lock", "migrate", "seed", "tokens", "site"]) {
      expect({ step, journaled: phases.some((p) => p.startsWith(`prepare:${step}:`)) }).toEqual({ step, journaled: false });
    }
    // The running stack is exactly as it was: same containers, never restarted.
    const after = containerIdentity(h.project);
    for (const service of ["api", "postgres"]) {
      expect({ service, id: after[service]?.id, startedAt: after[service]?.startedAt })
        .toEqual({ service, id: before[service]!.id, startedAt: before[service]!.startedAt });
    }
    // …and the schema it serves is the one it had.
    expect(bootQuery(h.project, "SELECT string_agg(name, ',' ORDER BY name) FROM schema_migrations")).toBe(ledgerBefore);
    expect(bootQuery(h.project, "SELECT content_hash FROM schema_manifest")).toBe(manifestBefore);
    expect(readlinkSync(join(h.paths.webDir, "current"))).toBe(liveId);
  }, BOOT_TIMEOUT_MS * 2);

  test("a legacy live site, and a plan that deploys this tree's including site: the boot proceeds past the site step", async () => {
    const { h, slot } = instanceWithLiveSite("webcompat-deploys", { same: false, range: null });
    slot.boot = spawnBoot(h, [], { ownProcessGroup: false });
    // Past the site step: `current` switched to the plan's site and the next
    // phase began. Then stop it at a boundary; the rest is smoke-lifecycle's.
    await waitFor(
      () => (journalNow(h)?.phases ?? []).some((r) => r.phase === "prepare" && r.step === "images"),
      BOOT_TIMEOUT_MS - 120_000,
      "the boot to pass the site step",
      slot.boot,
    );
    const out = slot.boot.output();
    expect(out).toContain(`web compat: API ${API} is inside ${siteId}'s range`);
    expect(out).not.toContain("refusing to replace api");
    const site = journalNow(h)!.phases.find((r) => r.phase === "prepare" && r.step === "site");
    expect(site?.status).toBe("committed");
    expect(readlinkSync(join(h.paths.webDir, "current"))).toBe(siteId);
    slot.boot.proc.kill("SIGINT");
    await slot.boot.exited;
  }, BOOT_TIMEOUT_MS);
});
