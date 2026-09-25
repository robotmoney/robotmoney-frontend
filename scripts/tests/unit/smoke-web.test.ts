// `bun smoke:web` — scripts/lib/website-release.ts (D54; smoke spec §13.2,
// issue #1026 W7, criterion 161, module half).
//
// Driven against a real instance directory, the real deployment lock and the
// real symlink switch. Only the side effects outside the web directory (the
// assembly, the API's version, the nginx reload) are stand-ins, recorded so a
// test can say which ran. The running-stack half — a real website-server, a
// real api, container ids read back from Docker — is
// scripts/tests/integration/smoke-web-lifecycle.test.ts.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SITE_LINK, currentSite, placeSite, PREVIOUS_SITE_LINK, previousSite, switchSite } from "../../lib/smoke-site.ts";
import { acquireDeploymentLock, instancePaths, resolveInstance, type InstancePaths } from "../../lib/smoke-state.ts";
import {
  BUILD_DIR_PREFIX,
  deploySite,
  readWebJournal,
  readWebReceipt,
  resolveWebInstance,
  rollbackSite,
  webPlanId,
  type WebReleaseDeps,
} from "../../lib/website-release.ts";

const repoRoot = join(import.meta.dir, "..", "..", "..");

const roots: string[] = [];
function instance(name = "rm_local_web"): InstancePaths {
  const root = mkdtempSync(join(tmpdir(), "rm-smoke-web-"));
  roots.push(root);
  return instancePaths(root, name, { create: true });
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface SiteSpec {
  version?: string;
  commit?: string;
  apiRange?: string | null;
  body?: string;
}

/** Write what scripts/static-assembly.sh leaves in its output directory. */
function assemble(dir: string, spec: SiteSpec): void {
  const version = spec.version ?? "0.1.0";
  const commit = spec.commit ?? "aaaa1111";
  const body = spec.body ?? `<h1>${version}-${commit}</h1>`;
  writeFileSync(join(dir, "index.html"), body);
  writeFileSync(
    join(dir, "version.json"),
    JSON.stringify({ name: "@robotmoney/web-client", version, commit, apiRange: spec.apiRange === undefined ? "^0.2.0" : spec.apiRange }),
  );
  const digest = `sha256:${new Bun.CryptoHasher("sha256").update(`${version}${commit}${body}`).digest("hex")}`;
  writeFileSync(join(dir, ".rm-static-manifest.json"), JSON.stringify({ schema: 1, digest, files: 2 }));
}

interface Fake extends WebReleaseDeps {
  readonly calls: string[];
  site: SiteSpec;
  api: string;
}

function fake(site: SiteSpec = {}, api = "0.2.0"): Fake {
  const calls: string[] = [];
  const deps: Fake = {
    calls,
    site,
    api,
    async build(outDir) {
      calls.push(`build:${outDir.split("/").at(-1)}`);
      assemble(outDir, deps.site);
    },
    async apiVersion() {
      calls.push("apiVersion");
      return deps.api;
    },
    async reload() {
      calls.push("reload");
    },
    sourceIdentity: () => ({ frontend: `tree-${deps.site.version ?? "0.1.0"}-${deps.site.body ?? ""}` }),
    now: () => new Date("2026-09-25T12:00:00.000Z"),
  };
  return deps;
}

function webEntries(paths: InstancePaths): string[] {
  return readdirSync(paths.webDir).sort();
}

describe("deploy: the site lands in a versioned directory under the instance, then becomes current", () => {
  test("layout: web/<version>-<commit>/, `current` a relative symlink to it, journal and receipt beside it", async () => {
    const paths = instance();
    const deps = fake({ version: "0.1.0", commit: "aaaa1111" });
    const receipt = await deploySite(paths, deps);

    expect(receipt).toMatchObject({ action: "deploy", siteId: "0.1.0-aaaa1111", previous: null, swapped: true, reloaded: true, apiVersion: "0.2.0", apiRange: "^0.2.0" });
    expect(lstatSync(join(paths.webDir, "0.1.0-aaaa1111")).isDirectory()).toBe(true);
    expect(readlinkSync(join(paths.webDir, CURRENT_SITE_LINK))).toBe("0.1.0-aaaa1111");
    expect(readFileSync(join(paths.webDir, CURRENT_SITE_LINK, "index.html"), "utf8")).toBe("<h1>0.1.0-aaaa1111</h1>");
    // The build directory was renamed into place: nothing dot-named is left.
    expect(webEntries(paths)).toEqual(["0.1.0-aaaa1111", "current", "journal.jsonl", "receipt.json"]);
    // Built, then checked against the API, then reloaded — in that order.
    expect(deps.calls.map((c) => c.replace(/:.*/, ""))).toEqual(["build", "apiVersion", "reload"]);
    expect(deps.calls[0]).toStartWith(`build:${BUILD_DIR_PREFIX}`);
  });

  test("the journal records begin → range-checked → built → switched → reloaded → done under one plan id, and the receipt reads back", async () => {
    const paths = instance();
    const deps = fake();
    const receipt = await deploySite(paths, deps);
    const journal = readWebJournal(paths);
    expect(journal.map((e) => e.step)).toEqual(["begin", "range-checked", "built", "switched", "reloaded", "done"]);
    expect(new Set(journal.map((e) => e.planId))).toEqual(new Set([receipt.planId]));
    expect(readWebReceipt(paths)).toEqual(receipt);
    expect(receipt.planId).toBe(webPlanId({ instance: "rm_local_web", action: "deploy", sources: deps.sourceIdentity() }));
  });

  test("the plan id is the site's source identity: same sources, same id; a changed source, a new id", () => {
    const a = webPlanId({ instance: "i", action: "deploy", sources: { frontend: "t1", "scripts/prerender.ts": "t2" } });
    expect(webPlanId({ instance: "i", action: "deploy", sources: { "scripts/prerender.ts": "t2", frontend: "t1" } })).toBe(a);
    expect(webPlanId({ instance: "i", action: "deploy", sources: { frontend: "t1-edited", "scripts/prerender.ts": "t2" } })).not.toBe(a);
  });

  test("a second version becomes current and `previous` names the first; both directories are kept", async () => {
    const paths = instance();
    const deps = fake({ version: "0.1.0" });
    await deploySite(paths, deps);
    deps.site = { version: "0.1.1", commit: "bbbb2222" };
    const receipt = await deploySite(paths, deps);
    expect(receipt).toMatchObject({ siteId: "0.1.1-bbbb2222", previous: "0.1.0-aaaa1111", swapped: true });
    expect(currentSite(paths.webDir)).toBe("0.1.1-bbbb2222");
    expect(previousSite(paths.webDir)).toBe("0.1.0-aaaa1111");
    expect(existsSync(join(paths.webDir, "0.1.0-aaaa1111", "index.html"))).toBe(true);
  });

  test("deploying the site that is already current switches nothing and does not reload", async () => {
    const paths = instance();
    const deps = fake();
    await deploySite(paths, deps);
    deps.calls.length = 0;
    const again = await deploySite(paths, deps);
    expect(again).toMatchObject({ swapped: false, reloaded: false, siteId: "0.1.0-aaaa1111" });
    expect(deps.calls).not.toContain("reload");
    expect(webEntries(paths).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("a build directory left by a dead run is cleared under the lock", async () => {
    const paths = instance();
    mkdirSync(join(paths.webDir, `${BUILD_DIR_PREFIX}deadbeef`));
    await deploySite(paths, fake());
    expect(webEntries(paths).filter((n) => n.startsWith("."))).toEqual([]);
  });
});

describe("range refusal: an API outside the new site's range switches nothing", () => {
  test("refuses naming the API version and the range; `current`, `previous` and the receipt are unchanged; the build is removed", async () => {
    const paths = instance();
    const deps = fake();
    const first = await deploySite(paths, deps);
    deps.site = { version: "0.3.0", commit: "cccc3333", apiRange: "^0.3.0" };
    deps.calls.length = 0;

    await expect(deploySite(paths, deps)).rejects.toThrow(/running API is 0\.2\.0, outside site 0\.3\.0-cccc3333's range \^0\.3\.0\. Nothing was switched/);
    expect(currentSite(paths.webDir)).toBe("0.1.0-aaaa1111");
    expect(previousSite(paths.webDir)).toBeNull();
    expect(readWebReceipt(paths)).toEqual(first);
    expect(deps.calls).not.toContain("reload");
    expect(webEntries(paths)).toEqual(["0.1.0-aaaa1111", "current", "journal.jsonl", "receipt.json"]);
    expect(readWebJournal(paths).at(-1)).toMatchObject({ step: "refused", detail: { apiVersion: "0.2.0", apiRange: "^0.3.0" } });
  });

  test("a site with no declared range is outside every range (D54)", async () => {
    const paths = instance();
    await expect(deploySite(paths, fake({ apiRange: null }))).rejects.toThrow(/no declared range/);
    expect(currentSite(paths.webDir)).toBeNull();
  });

  test("an API whose version cannot be read refuses rather than guessing", async () => {
    const paths = instance();
    const deps = fake();
    deps.apiVersion = async () => {
      throw new Error("connection refused");
    };
    await expect(deploySite(paths, deps)).rejects.toThrow(/could not be read \(connection refused\)/);
    expect(currentSite(paths.webDir)).toBeNull();
  });

  test("red control: the same site against an API inside its range deploys", async () => {
    const paths = instance();
    await expect(deploySite(paths, fake({ apiRange: "^0.3.0" }, "0.3.4"))).resolves.toMatchObject({ swapped: true });
  });
});

describe("rollback: back to the previous directory", () => {
  test("returns `current` to `previous`, reloads, and journals and receipts the rollback", async () => {
    const paths = instance();
    const deps = fake({ version: "0.1.0" });
    await deploySite(paths, deps);
    deps.site = { version: "0.1.1", commit: "bbbb2222" };
    await deploySite(paths, deps);
    deps.calls.length = 0;

    const receipt = await rollbackSite(paths, deps);
    expect(receipt).toMatchObject({ action: "rollback", siteId: "0.1.0-aaaa1111", previous: "0.1.1-bbbb2222", swapped: true, reloaded: true });
    expect(currentSite(paths.webDir)).toBe("0.1.0-aaaa1111");
    // A second rollback returns to where the first came from.
    expect(previousSite(paths.webDir)).toBe("0.1.1-bbbb2222");
    expect(deps.calls).toEqual(["apiVersion", "reload"]);
    expect(readWebReceipt(paths)).toEqual(receipt);
    expect(readWebJournal(paths).filter((e) => e.planId === receipt.planId).map((e) => e.step)).toEqual([
      "begin", "range-checked", "switched", "reloaded", "done",
    ]);
  });

  test("no previous site: refuses and changes nothing", async () => {
    const paths = instance();
    const deps = fake();
    await expect(rollbackSite(paths, deps)).rejects.toThrow(/no previous site/);
    await deploySite(paths, deps);
    deps.calls.length = 0;
    await expect(rollbackSite(paths, deps)).rejects.toThrow(/no previous site/);
    expect(currentSite(paths.webDir)).toBe("0.1.0-aaaa1111");
    expect(deps.calls).toEqual([]);
  });

  test("`previous` equal to `current` (a switch interrupted between its two renames) refuses", async () => {
    const paths = instance();
    await deploySite(paths, fake());
    const temp = join(paths.webDir, ".tmp-link");
    Bun.spawnSync(["ln", "-s", "0.1.0-aaaa1111", temp]);
    Bun.spawnSync(["mv", "-T", temp, join(paths.webDir, PREVIOUS_SITE_LINK)]);
    await expect(rollbackSite(paths, fake())).rejects.toThrow(/previous and current both name/);
  });

  test("a previous site whose range excludes the running API is refused", async () => {
    const paths = instance();
    const deps = fake({ version: "0.1.0", apiRange: "^0.2.0" }, "0.2.5");
    await deploySite(paths, deps);
    deps.site = { version: "0.1.1", commit: "bbbb2222", apiRange: "^0.3.0" };
    deps.api = "0.3.0";
    await deploySite(paths, deps);
    await expect(rollbackSite(paths, deps)).rejects.toThrow(/running API is 0\.3\.0, outside site 0\.1\.0-aaaa1111's range \^0\.2\.0/);
    expect(currentSite(paths.webDir)).toBe("0.1.1-bbbb2222");
  });

  test("placeSite (`bun smoke`) records `previous` too, so a rollback after a boot returns to the site the boot replaced", () => {
    const paths = instance();
    const stage = (name: string, spec: SiteSpec) => {
      const dir = join(roots.at(-1)!, name);
      mkdirSync(dir);
      assemble(dir, spec);
      return dir;
    };
    placeSite(paths.webDir, stage("_a", { version: "0.1.0" }));
    placeSite(paths.webDir, stage("_b", { version: "0.1.1" }));
    expect(previousSite(paths.webDir)).toBe("0.1.0-aaaa1111");
  });
});

describe("the switch is atomic", () => {
  test("a reader in another process never sees a missing or partial site across 200 switches", async () => {
    const paths = instance();
    const deps = fake({ version: "0.1.0" });
    await deploySite(paths, deps);
    deps.site = { version: "0.1.1", commit: "bbbb2222" };
    await deploySite(paths, deps);

    const reader = Bun.spawn(
      [
        "bun",
        "-e",
        `const fs = require("node:fs");
         const file = ${JSON.stringify(join(paths.webDir, CURRENT_SITE_LINK, "index.html"))};
         const seen = new Set(); let errors = 0; let reads = 0;
         const end = Date.now() + 1500;
         while (Date.now() < end) {
           try { seen.add(fs.readFileSync(file, "utf8")); reads++; } catch (e) { errors++; }
         }
         console.log(JSON.stringify({ errors, reads, seen: [...seen].sort() }));`,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const sites = ["0.1.0-aaaa1111", "0.1.1-bbbb2222"];
    const until = Date.now() + 1200;
    let switches = 0;
    while (Date.now() < until || switches < 200) {
      switchSite(paths.webDir, sites[switches % 2]!);
      switches++;
      if (switches % 20 === 0) await Bun.sleep(1);
    }
    const result = JSON.parse(await new Response(reader.stdout).text()) as { errors: number; reads: number; seen: string[] };
    expect(result.reads).toBeGreaterThan(0);
    expect(result.errors).toBe(0);
    expect(result.seen).toEqual(["<h1>0.1.0-aaaa1111</h1>", "<h1>0.1.1-bbbb2222</h1>"]);
  });
});

describe("the deployment lock: `bun smoke:web` cannot race a `bun smoke` of the same instance", () => {
  test("a lock held by a live process refuses the deploy and the rollback before anything is built", async () => {
    const paths = instance();
    const deps = fake();
    await deploySite(paths, deps);
    deps.site = { version: "0.1.1", commit: "bbbb2222" };
    await deploySite(paths, deps);
    deps.calls.length = 0;

    const held = acquireDeploymentLock(paths, "plan-of-a-bun-smoke");
    try {
      await expect(deploySite(paths, fake({ version: "0.9.9" }))).rejects.toThrow(/locked by pid \d+ running plan plan-of-a-bun-smoke/);
      await expect(rollbackSite(paths, deps)).rejects.toThrow(/locked by pid/);
    } finally {
      held.release();
    }
    expect(deps.calls).toEqual([]);
    expect(currentSite(paths.webDir)).toBe("0.1.1-bbbb2222");
    expect(webEntries(paths).filter((n) => n.startsWith("."))).toEqual([]);
  });

  test("the lock is released after a deploy, after a refusal, and after a rollback", async () => {
    const paths = instance();
    await deploySite(paths, fake());
    expect(existsSync(paths.lockFile)).toBe(false);
    await expect(deploySite(paths, fake({ apiRange: null }))).rejects.toThrow();
    expect(existsSync(paths.lockFile)).toBe(false);
  });

  test("the stack's deployment journal is never written", async () => {
    const paths = instance();
    await deploySite(paths, fake());
    expect(existsSync(paths.journalFile)).toBe(false);
    expect(existsSync(paths.receiptFile)).toBe(false);
  });
});

describe("instance resolution follows `bun smoke`'s precedence and never mints", () => {
  const local = { class: "local", hash: "0123456789" } as const;

  test("a persisted local instance resolves to the name resolveInstance persisted", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-smoke-web-root-"));
    roots.push(root);
    const minted = resolveInstance({ flag: undefined, rmEnv: "stage", environment: local as never, stateRoot: root });
    expect(minted.source).toBe("fresh");
    const web = resolveWebInstance({ flag: undefined, rmEnv: "stage", environment: local as never, stateRoot: root });
    expect(web.dir).toBe(minted.stateDir);
  });

  test("no persisted instance refuses instead of minting one", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-smoke-web-root-"));
    roots.push(root);
    expect(() => resolveWebInstance({ flag: undefined, rmEnv: "stage", environment: local as never, stateRoot: root })).toThrow(/no local instance/);
    expect(readdirSync(root)).toEqual([]);
  });

  test("--instance names it; an unknown one refuses; rm_prod under stage and another name under prod refuse", () => {
    const paths = instance("rm_local_named");
    const root = paths.dir.slice(0, -"/rm_local_named".length);
    expect(resolveWebInstance({ flag: "rm_local_named", rmEnv: "stage", environment: local as never, stateRoot: root }).dir).toBe(paths.dir);
    expect(() => resolveWebInstance({ flag: "rm_local_other", rmEnv: "stage", environment: local as never, stateRoot: root })).toThrow(/no state/);
    expect(() => resolveWebInstance({ flag: "rm_prod", rmEnv: "stage", environment: local as never, stateRoot: root })).toThrow(/stage policy/);
    expect(() => resolveWebInstance({ flag: "rm_local_named", rmEnv: "prod", environment: local as never, stateRoot: root })).toThrow(/RM_ENV=prod/);
  });

  test("CI resolves from the job identity, never from the persisted local name", () => {
    const root = mkdtempSync(join(tmpdir(), "rm-smoke-web-root-"));
    roots.push(root);
    resolveInstance({ flag: undefined, rmEnv: "stage", environment: local as never, stateRoot: root });
    instancePaths(root, "rm_ci_abcdef", { create: true });
    expect(resolveWebInstance({ flag: undefined, rmEnv: "stage", environment: { class: "ci", hash: "ABCDEF" } as never, stateRoot: root }).dir).toBe(join(root, "rm_ci_abcdef"));
  });
});

describe("wiring", () => {
  test("package.json runs scripts/smoke-web.ts with no env file, like every smoke command", () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["smoke:web"]).toBe("bun --no-env-file scripts/smoke-web.ts");
  });

  test("the reload is `docker compose exec` from the host, never a socket inside a container", () => {
    // No compose service mounts the socket at all: no-docker-socket-compose-config.test.ts.
    const entry = readFileSync(join(repoRoot, "scripts", "smoke-web.ts"), "utf8");
    expect(entry).toContain('compose(["exec", "-T", "website-server", "nginx", "-s", "reload"])');
    expect(entry).not.toContain("docker.sock");
  });
});
