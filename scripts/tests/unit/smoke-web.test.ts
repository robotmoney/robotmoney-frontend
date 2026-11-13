// `bun smoke:web` — scripts/lib/website-release.ts (D54; smoke spec §13.2,
// issue #1026 W7, criterion 161, module half).
//
// Driven against a real instance directory, the real deployment lock and the
// real symlink switch. Only the side effects outside the web directory (the
// assembly, the API's version, the nginx reload) are stand-ins, recorded so a
// test can say which ran. The running-stack half — a real website-server, a
// real api, container ids read back from Docker — is
// scripts/tests/integration/smoke-web-dir-lifecycle.test.ts.
//
// The image mode (issue 1628) is the second half of this file: a fake host
// that records the command list, real HTTP ports, and a real signed bundle.
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CURRENT_SITE_LINK, currentSite, placeSite, PREVIOUS_SITE_LINK, previousSite, switchSite } from "../../lib/smoke-site.ts";
import { acquireDeploymentLock, instancePaths, resolveInstance, type InstancePaths } from "../../lib/smoke-state.ts";
import { packBundle, signBundle } from "../../lib/web-bundle.ts";
import { WEB_BUNDLE_SIGNATURE_NAMESPACE } from "../../lib/web-bundle-manifest.ts";
import { shellQuote, sshArgv, sshHost, type HostResult, type WebHost } from "../../lib/website-host.ts";
import {
  readWebsiteImageService,
  WEBSITE_ASSET_CACHE,
  WEBSITE_HTML_CACHE,
  WEBSITE_SECURITY_HEADERS,
  websiteImageRunFlags,
} from "../../lib/website-image.ts";
import {
  assertImageInstance,
  BUILD_DIR_PREFIX,
  deployImage,
  deploySite,
  FIRST_ROLLOUT_SUFFIX,
  handoverScript,
  GAP_LIMIT_MS,
  hostLockName,
  IMAGE_JOURNAL_FILE,
  isReleaseName,
  publicPortBinding,
  readImageReceipt,
  readWebJournal,
  readWebReceipt,
  replacementCreateArgs,
  resolveWebInstance,
  rollbackImage,
  rollbackSite,
  SERVER_PIN_REPO,
  siteImageTag,
  webPlanId,
  type ContainerInspect,
  type ImageReleaseDeps,
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

// ===========================================================================
// IMAGE MODE (issue 1628; web-serving-architecture.md §4, §4.1). The host is
// a fake: it answers each `docker …` command from a small state machine and
// records the command list, and each port it publishes is a real local HTTP
// server whose answers follow that state. The bundle is real: packed and
// signed with a key made here, verified by web-bundle.ts. The real Docker
// half is scripts/tests/integration/smoke-web-lifecycle.test.ts and
// smoke-web-rolling.test.ts.
// ===========================================================================

const OLD_ID = "a".repeat(64);
const NEW_ID = "b".repeat(64);
const OLD_IMAGE = `sha256:${"1".repeat(64)}`;
const NEW_IMAGE = `sha256:${"2".repeat(64)}`;
const PREV_IMAGE = `sha256:${"3".repeat(64)}`;
const SERVER_ID = `sha256:${"4".repeat(64)}`;
const PUBLIC_PORT = 48787;
const COPY_PORT = 40001;
const OLD_RELEASE = { version: "0.1.0", commit: "aaaa111" };
const IMAGE_INSTANCE = "stage_target";
const KEPT_ID = "c".repeat(64);
const NGINX_IMAGE = `sha256:${"5".repeat(64)}`;
const KEPT_RELEASE = { version: "0.0.1", commit: "nginx01" };

interface FakeHostState {
  api: string;
  /** Which container answers on the public port. */
  serving: "old" | "new" | "kept" | "none";
  newRelease: { version: string; commit: string };
  previousRelease: { version: string; commit: string; apiRange: string | null };
  hostVerifyFails: boolean;
  copyBroken: boolean;
  lockHeld: boolean;
  hasPrevious: boolean;
  /** The old container runs nginx (no site image yet): the host's first swap. */
  oldIsNginx: boolean;
  /** A stopped first-rollout nginx container is kept (§4 first-rollout rule). */
  keptNginx: boolean;
  /** The new container fails to start. */
  newStartFails: boolean;
  /** These docker sub-commands (by their first two words, e.g. "rename"), fail. */
  failing: string[];
  /** The serving bundle's digest (labels of the old container), when it equals the deployed one. */
  servingSha: string | null;
  /** The server image's layers (a different first layer = a new server image). */
  serverLayers: string[];
  /** Nothing runs: every website-server is stopped. */
  allStopped: boolean;
  /** The image `-current` names, or null. */
  currentTag: string | null;
  /** The id the build gives the candidate. */
  candidateImage: string;
}

interface FakeHost extends WebHost {
  readonly state: FakeHostState;
  /** The commands, each joined with spaces, for matching. */
  lines(): string[];
}

const securityHeaders = (html: boolean) => ({ ...WEBSITE_SECURITY_HEADERS, "cache-control": html ? WEBSITE_HTML_CACHE : WEBSITE_ASSET_CACHE });

function oldInspect(): ContainerInspect {
  return {
    Id: OLD_ID,
    Name: "/rm_stage_target-website-server-1",
    Image: OLD_IMAGE,
    State: { Running: true },
    Config: {
      Labels: {
        "com.docker.compose.project": "rm_stage_target",
        "com.docker.compose.service": "website-server",
        "robotmoney.instance": IMAGE_INSTANCE,
        "robotmoney.smoke": "1",
        "robotmoney.web.tag": "web-v0.1.0",
        "robotmoney.web.bundle-sha256": "f".repeat(64),
        maintainer: "caddy",
      },
      Healthcheck: { Test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"], Interval: 15e9, Timeout: 5e9, Retries: 3, StartPeriod: 10e9 },
    },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      LogConfig: { Type: "json-file", Config: { "max-size": "10m" } },
      PortBindings: { "8080/tcp": [{ HostIp: "", HostPort: "48787" }] },
    },
    NetworkSettings: {
      Ports: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "48787" }, { HostIp: "::", HostPort: "48787" }] },
      Networks: { rm_stage_target_default: { Aliases: ["rm_stage_target-website-server-1", "website-server", OLD_ID.slice(0, 12)] } },
    },
  };
}

/** The kept first-rollout nginx container: stopped, no site labels, its own web/ mount. */
function keptInspect(): ContainerInspect {
  const o = oldInspect();
  return {
    ...o,
    Id: KEPT_ID,
    Name: `/rm_stage_target-website-server-1${FIRST_ROLLOUT_SUFFIX}`,
    Image: NGINX_IMAGE,
    State: { Running: false },
    Config: { ...o.Config, Labels: Object.fromEntries(Object.entries(o.Config.Labels!).filter(([k]) => !k.startsWith("robotmoney.web."))) },
    NetworkSettings: { ...o.NetworkSettings, Ports: {} },
  };
}

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

function fakeHost(over: Partial<FakeHostState> = {}): FakeHost {
  const state: FakeHostState = {
    api: "0.2.0",
    serving: "old",
    newRelease: { version: "0.2.0", commit: "bbbb222" },
    previousRelease: { version: "0.0.9", commit: "cccc333", apiRange: "^0.2.0" },
    hostVerifyFails: false,
    copyBroken: false,
    lockHeld: false,
    hasPrevious: true,
    oldIsNginx: false,
    keptNginx: false,
    newStartFails: false,
    failing: [],
    servingSha: null,
    serverLayers: ["sha256:l1"],
    allStopped: false,
    currentTag: null,
    candidateImage: NEW_IMAGE,
    ...over,
  };
  let copyRelease = state.newRelease;
  const json = (body: unknown, headers: Record<string, string> = {}) => Response.json(body, { headers });
  const publicServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (state.serving === "none") return new Response("down", { status: 502 });
      if (path === "/api/version") return json({ api: state.api, commit: "c0ffee0" });
      if (path === "/version.json") return json(state.serving === "old" ? OLD_RELEASE : state.serving === "kept" ? KEPT_RELEASE : copyRelease, securityHeaders(false));
      return new Response("<!doctype html>", { headers: securityHeaders(true) });
    },
  });
  const copyServer = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/version.json") return json(copyRelease, securityHeaders(false));
      if (path.endsWith(".js")) return new Response("missing", { status: 404, headers: securityHeaders(false) });
      if (state.copyBroken) return new Response("not found", { status: 404, headers: securityHeaders(true) });
      return new Response("<!doctype html>", { headers: securityHeaders(true) });
    },
  });
  servers.push(publicServer, copyServer);
  const commands: string[][] = [];
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const no = (stderr: string) => ({ code: 1, stdout: "", stderr });
  const labelsOf = (ref: string) => {
    if (ref !== state.candidateImage && (ref === PREV_IMAGE || ref === siteImageTag(IMAGE_INSTANCE, "previous"))) {
      return { "robotmoney.web.tag": `web-v${state.previousRelease.version}`, "robotmoney.web.commit": state.previousRelease.commit, "robotmoney.web.bundle-sha256": "e".repeat(64) };
    }
    if (ref === OLD_IMAGE) return { "robotmoney.web.tag": "web-v0.1.0", "robotmoney.web.commit": OLD_RELEASE.commit };
    if (ref === state.candidateImage || ref === NEW_IMAGE || ref.endsWith("-candidate")) {
      return { "robotmoney.web.tag": `web-v${state.newRelease.version}`, "robotmoney.web.commit": state.newRelease.commit, "robotmoney.web.bundle-sha256": built.sha256 };
    }
    return {};
  };
  const built = { sha256: "" };
  const docker = (a: string[]): HostResult => {
    const joined = a.join(" ");
    switch (a[0]) {
      case "network":
        if (a[1] === "create") return state.lockHeld ? no("network with name robotmoney-web-lock-stage_target already exists") : ok("lockid");
        if (a[1] === "inspect") return ok(new Date().toISOString());
        return ok();
      case "ps":
        if (joined.includes(`name=${FIRST_ROLLOUT_SUFFIX}`)) return ok(state.keptNginx ? KEPT_ID : "");
        if (state.allStopped) return a.includes("-aq") ? ok(OLD_ID) : ok("");
        return ok(OLD_ID);
      case "inspect": {
        if (a[1] === KEPT_ID) return ok(JSON.stringify([keptInspect()]));
        const o = oldInspect();
        if (state.oldIsNginx) {
          o.Image = NGINX_IMAGE;
          o.Config.Labels = Object.fromEntries(Object.entries(o.Config.Labels!).filter(([k]) => !k.startsWith("robotmoney.web.")));
        }
        if (state.servingSha !== null) o.Config.Labels!["robotmoney.web.bundle-sha256"] = state.servingSha;
        return ok(JSON.stringify([o]));
      }
      case "image": {
        const ref = a.at(-1)!;
        if (joined.includes("{{.Id}}")) {
          if (ref === siteImageTag(IMAGE_INSTANCE, "previous")) return state.hasPrevious ? ok(PREV_IMAGE) : no("No such image");
          if (ref.endsWith("-candidate")) return ok(state.candidateImage);
          if (ref === siteImageTag(IMAGE_INSTANCE, "current")) return state.currentTag === null ? no("No such image") : ok(state.currentTag);
          if (ref === "robotmoney-website-server:platform") return ok(SERVER_ID);
          return no("No such image");
        }
        if (joined.includes("RootFS")) {
          if (ref === SERVER_ID) return ok(JSON.stringify(state.serverLayers));
          if (ref === state.candidateImage) return ok(JSON.stringify([...state.serverLayers, "sha256:l2"]));
          return ok(JSON.stringify(["sha256:l1", "sha256:l2"]));
        }
        return ok(JSON.stringify(labelsOf(ref)));
      }
      case "run":
        if (joined.includes("rm-verify-web-bundle")) return state.hostVerifyFails ? no("web bundle refused: no key in /etc/robotmoney/allowed-signers signed it") : ok("verified");
        if (joined.includes("--volumes-from")) return ok(JSON.stringify({ ...KEPT_RELEASE, apiRange: "^0.2.0" }));
        if (joined.includes("--entrypoint cat")) return ok(JSON.stringify({ ...state.previousRelease }));
        // The throwaway copy serves the image it was started from.
        copyRelease = a.at(-1) === PREV_IMAGE ? state.previousRelease : state.newRelease;
        return ok("copyid");
      case "build":
        built.sha256 = a.find((x) => x.startsWith("BUNDLE_SHA256="))!.slice("BUNDLE_SHA256=".length);
        return ok(NEW_IMAGE);
      case "port":
        return ok(`127.0.0.1:${COPY_PORT}`);
      case "create":
        return ok(NEW_ID);
      case "stop":
        state.serving = "none";
        return ok();
      case "start":
        if (a[1] === NEW_ID && state.newStartFails) return no("Error response from daemon: driver failed programming external connectivity");
        state.serving = a[1] === NEW_ID ? "new" : a[1] === KEPT_ID ? "kept" : "old";
        return ok();
      case "exec":
        return no("cat: can't open: No such file");
      case "images":
        return ok([NEW_IMAGE, OLD_IMAGE, PREV_IMAGE].join("\n"));
      default:
        return ok();
    }
  };
  const dockerOrFail = (a: string[]): HostResult => (state.failing.includes(a[0]!) ? no(`docker ${a[0]} failed by the test`) : docker(a));
  // The one-command handover (handoverScript): each docker line is recorded as if sent alone, in order.
  const words = (line: string) => line.split(" ").map((w) => w.replace(/^'|'$/g, ""));
  const handover = (script: string): string => {
    for (const line of script.split("\n")) {
      const plain = /^docker (.*) >\/dev\/null 2>&1$/.exec(line);
      if (plain) {
        const a = words(plain[1]!);
        commands.push(["docker", ...a]);
        dockerOrFail(a);
        continue;
      }
      const branch = /^if err=\$\(docker (start \S+) 2>&1 >\/dev\/null\); then echo started; else (?:docker (start \S+) >\/dev\/null 2>&1; )?/.exec(line);
      if (branch) {
        const a = words(branch[1]!);
        commands.push(["docker", ...a]);
        const r = dockerOrFail(a);
        if (r.code === 0) return "started";
        if (branch[2]) {
          const f = words(branch[2]);
          commands.push(["docker", ...f]);
          dockerOrFail(f);
        }
        return `failed: ${r.stderr}`;
      }
    }
    throw new Error(`the fake host cannot read the handover script:\n${script}`);
  };
  return {
    name: "fake-host",
    commands,
    state,
    lines: () => commands.map((c) => c.join(" ")),
    async run(argv) {
      commands.push([...argv]);
      if (argv[0] === "mktemp") return ok("/host/work");
      if (argv[0] === "sh" && argv[2]?.includes("echo started")) return ok(handover(argv[2]));
      if (argv[0] !== "docker") return ok();
      return dockerOrFail(argv.slice(1));
    },
    async openPort(port) {
      if (port === PUBLIC_PORT) return { origin: `http://127.0.0.1:${publicServer.port}`, close() {} };
      if (port === COPY_PORT) return { origin: `http://127.0.0.1:${copyServer.port}`, close() {} };
      throw new Error(`the fake host publishes no port ${port}`);
    },
    close() {},
  };
}

/** A real signed bundle for `release` with `apiRange`, and the allowed-signers file that trusts its key. */
function signedTestBundle(release: { version: string; commit: string }, apiRange: string | null): { bundle: string; allowedSigners: string; sha256: string } {
  const root = mkdtempSync(join(tmpdir(), "rm-smoke-web-image-"));
  roots.push(root);
  const key = join(root, "key");
  const kg = Bun.spawnSync(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", key], { stdout: "pipe", stderr: "pipe" });
  if (kg.exitCode !== 0) throw new Error(`ssh-keygen failed: ${kg.stderr.toString()}`);
  const pub = readFileSync(`${key}.pub`, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
  const allowedSigners = join(root, "allowed-signers");
  writeFileSync(allowedSigners, `test namespaces="${WEB_BUNDLE_SIGNATURE_NAMESPACE}" ${pub}\n`);
  const site = join(root, "site");
  mkdirSync(site);
  writeFileSync(join(site, "index.html"), "<!doctype html>");
  writeFileSync(join(site, "version.json"), JSON.stringify({ ...release, apiRange }));
  const packed = packBundle(site, join(root, "out"));
  signBundle(packed.path, key);
  return { bundle: packed.path, allowedSigners, sha256: packed.sha256 };
}

function imageDeps(host: FakeHost, extra: Partial<ImageReleaseDeps> = {}): ImageReleaseDeps & { receiptDir: string } {
  const receiptDir = mkdtempSync(join(tmpdir(), "rm-smoke-web-receipt-"));
  roots.push(receiptDir);
  return { host, instance: IMAGE_INSTANCE, receiptDir, repoRoot, readyTimeoutMs: 3_000, ...extra };
}

async function deployFake(host: FakeHost, apiRange: string | null = "^0.2.0", extra: Partial<ImageReleaseDeps> = {}) {
  const b = signedTestBundle(host.state.newRelease, apiRange);
  const deps = imageDeps(host, { allowedSigners: b.allowedSigners, ...extra });
  const result = await deployImage({ bundle: b.bundle, serverImage: "robotmoney-website-server:platform" }, deps).then(
    (receipt) => ({ receipt, error: null as Error | null }),
    (error: Error) => ({ receipt: readImageReceipt(deps.receiptDir)!, error }),
  );
  return { ...result, deps, sha256: b.sha256 };
}

const index = (lines: string[], pattern: RegExp) => lines.findIndex((l) => pattern.test(l));

describe("image mode: deploy (smoke:web --host --bundle)", () => {
  test("a passing swap: the receipt records the old and new container ids, every check's result and the gap in ms", async () => {
    const host = fakeHost();
    const { receipt, error, deps, sha256 } = await deployFake(host);
    expect(error).toBeNull();
    expect(receipt).toMatchObject({
      schema: 2,
      mode: "image",
      action: "deploy",
      outcome: "swapped",
      instance: IMAGE_INSTANCE,
      host: "fake-host",
      release: { tag: "web-v0.2.0", version: "0.2.0", commit: "bbbb222", sha256, apiRange: "^0.2.0" },
      apiVersion: "0.2.0",
      oldContainer: { id: OLD_ID, image: OLD_IMAGE },
      newContainer: { id: NEW_ID, image: NEW_IMAGE },
      publicPort: PUBLIC_PORT,
      copyPort: COPY_PORT,
      currentImage: NEW_IMAGE,
      previousImage: OLD_IMAGE,
      revertGap: null,
      error: null,
    });
    expect(receipt.checks.map((c) => [c.name, c.ok])).toEqual([
      ["verify-local", true],
      ["api-range", true],
      ["verify-host", true],
      ["build", true],
      ["copy", true],
      ["gap", true],
      ["public", true],
    ]);
    expect(typeof receipt.gap?.ms).toBe("number");
    expect(receipt.gap!.ms!).toBeGreaterThanOrEqual(0);
    expect(receipt.gap!.ms!).toBeLessThanOrEqual(GAP_LIMIT_MS);
    expect(Date.parse(receipt.gap!.endedAt!) - Date.parse(receipt.gap!.startedAt)).toBe(receipt.gap!.ms!);
    // Written on the control machine, and appended to the journal.
    expect(readImageReceipt(deps.receiptDir)).toEqual(receipt);
    expect(readFileSync(join(deps.receiptDir, IMAGE_JOURNAL_FILE), "utf8").trim().split("\n").map((l) => JSON.parse(l).outcome)).toEqual(["swapped"]);
  });

  test("the command list: lock, verify on the host, build FROM the pinned server id, check a copy, then stop, start, rename, keep one previous", async () => {
    const host = fakeHost();
    await deployFake(host);
    const lines = host.lines();
    const at = (p: RegExp) => {
      const i = index(lines, p);
      expect({ pattern: String(p), found: i >= 0 }).toEqual({ pattern: String(p), found: true });
      return i;
    };
    const order = [
      at(/^docker network create --internal .* robotmoney-web-lock-stage_target$/),
      at(/^docker image inspect --format \{\{\.Id\}\} robotmoney-website-server:platform$/),
      at(new RegExp(`^docker tag ${SERVER_ID} ${SERVER_PIN_REPO}:${"4".repeat(64)}$`)),
      at(new RegExp(`^docker run --rm --network none --user 0:0 -v /host/work/bundle:/in:ro --entrypoint rm-verify-web-bundle ${SERVER_ID} /in \\S+ web-v0\\.2\\.0 bbbb222 [0-9a-f]{64}$`)),
      at(new RegExp(`^docker build .*--build-arg SERVER_IMAGE=${SERVER_PIN_REPO}:${"4".repeat(64)} `)),
      at(/^docker run -d --rm --name robotmoney-web-check-stage_target-\S+ .*-p 127\.0\.0\.1::8080 /),
      at(/^docker create --name rm_stage_target-website-server-1-next-/),
      // The stop and the start are one host command (handoverScript), recorded line by line.
      at(/^sh -c trap '' HUP PIPE\n/),
      at(new RegExp(`^docker stop -t \\d+ ${OLD_ID}$`)),
      at(new RegExp(`^docker start ${NEW_ID}$`)),
      at(new RegExp(`^docker rename ${OLD_ID} rm_stage_target-website-server-1-old-[0-9a-f]{6}$`)),
      at(new RegExp(`^docker rename ${NEW_ID} rm_stage_target-website-server-1$`)),
      at(new RegExp(`^docker tag ${NEW_IMAGE} robotmoney-website:stage_target-current$`)),
      at(new RegExp(`^docker tag ${OLD_IMAGE} robotmoney-website:stage_target-previous$`)),
      at(new RegExp(`^docker rm ${OLD_ID}$`)),
      at(/^docker network rm robotmoney-web-lock-stage_target$/),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Every other image of the instance is removed: exactly one previous is kept.
    expect(lines).toContain(`docker rmi -f ${PREV_IMAGE}`);
    expect(lines).not.toContain(`docker rmi -f ${OLD_IMAGE}`);
    expect(lines).not.toContain(`docker rmi -f ${NEW_IMAGE}`);
    // The throwaway copy never names the public port.
    expect(lines.filter((l) => l.startsWith("docker run -d")).join("\n")).not.toContain(String(PUBLIC_PORT));
    // Every command is docker, mktemp, mkdir, rm or a `sh -c cat` write: nothing else is needed on the host.
    expect(new Set(host.commands.map((c) => c[0]))).toEqual(new Set(["docker", "mktemp", "mkdir", "sh", "rm"]));
  });

  test("a bundle that fails verification on the host is never built into an image", async () => {
    const host = fakeHost({ hostVerifyFails: true });
    const { receipt, error } = await deployFake(host);
    expect(error?.message).toMatch(/failed verification on fake-host: web bundle refused/);
    expect(receipt.outcome).toBe("refused");
    expect(receipt.checks.find((c) => c.name === "verify-host")).toMatchObject({ ok: false });
    const lines = host.lines();
    expect(index(lines, /rm-verify-web-bundle/)).toBeGreaterThan(0);
    expect(lines.filter((l) => /^docker (build|create|stop|start)\b/.test(l))).toEqual([]);
    // The bundle's directory on the host is removed, and the lock released.
    expect(lines).toContain("rm -rf /host/work");
    expect(lines.at(-1)).toBe("docker network rm robotmoney-web-lock-stage_target");
  });

  test("refuses an apiRange the running API does not accept, before anything reaches the host's images", async () => {
    const host = fakeHost({ api: "0.3.0" });
    const { receipt, error } = await deployFake(host, "^0.2.0");
    expect(error?.message).toBe("Refusing: the running API is 0.3.0, outside web-v0.2.0's range ^0.2.0. Nothing was changed.");
    expect(receipt).toMatchObject({ outcome: "refused", apiVersion: "0.3.0", newContainer: null, gap: null });
    expect(receipt.checks.map((c) => [c.name, c.ok])).toEqual([["verify-local", true], ["api-range", false]]);
    expect(host.lines().filter((l) => /^(docker (build|create|stop|start|tag)|mktemp)\b/.test(l))).toEqual([]);
  });

  test("a bundle with no declared range is outside every range", async () => {
    const host = fakeHost();
    const { error } = await deployFake(host, null);
    expect(error?.message).toMatch(/no declared range \(outside every range, D54\)/);
  });

  test("a bundle signed by no listed key is refused here, and nothing is sent to the host", async () => {
    const host = fakeHost();
    const b = signedTestBundle(host.state.newRelease, "^0.2.0");
    const other = signedTestBundle(host.state.newRelease, "^0.2.0");
    const deps = imageDeps(host, { allowedSigners: other.allowedSigners });
    await expect(deployImage({ bundle: b.bundle, serverImage: "robotmoney-website-server:platform" }, deps)).rejects.toThrow(/failed verification: no key in .* signed this bundle/);
    expect(readImageReceipt(deps.receiptDir)?.outcome).toBe("refused");
    expect(host.commands.map((c) => c.slice(0, 3).join(" "))).toEqual(["docker network create", "docker network rm"]);
  });

  test("a throwaway copy that fails its check never touches the public port", async () => {
    const host = fakeHost({ copyBroken: true });
    const { receipt, error } = await deployFake(host);
    expect(error?.message).toMatch(/throwaway copy of web-v0\.2\.0 failed its check: \/: status 404/);
    expect(receipt).toMatchObject({ outcome: "refused", newContainer: null, gap: null });
    expect(host.lines().filter((l) => /^docker (create|stop|start)\b/.test(l))).toEqual([]);
    expect(host.state.serving).toBe("old");
    // The candidate image is removed: it never served, so it is not kept.
    expect(host.lines()).toContain(`docker rmi -f ${NEW_IMAGE}`);
  });

  test("a failed public check starts the previous container again and fails, with the revert's gap", async () => {
    const wrong = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ version: "9.9.9", commit: "deadbee" }) });
    servers.push(wrong);
    const host = fakeHost();
    const { receipt, error } = await deployFake(host, "^0.2.0", { publicOrigin: `http://127.0.0.1:${wrong.port}` });
    expect(error?.message).toMatch(/The swap to web-v0\.2\.0 failed: .*does not name web-v0\.2\.0\. The previous website-server was started again\./);
    expect(receipt.outcome).toBe("reverted");
    expect(receipt.checks.find((c) => c.name === "public")).toMatchObject({ ok: false });
    expect(receipt.checks.find((c) => c.name === "revert")).toMatchObject({ ok: true });
    expect(typeof receipt.revertGap?.ms).toBe("number");
    expect(host.state.serving).toBe("old");
    const lines = host.lines();
    expect(index(lines, new RegExp(`^docker rm -f ${NEW_ID}$`))).toBeLessThan(index(lines, new RegExp(`^docker start ${OLD_ID}$`)));
    expect(lines).not.toContain(`docker rm ${OLD_ID}`);
    expect(lines.filter((l) => l.startsWith("docker tag ") && l.includes("robotmoney-website:"))).toEqual([]);
  }, 20_000);

  test("a held host lock refuses the run, and the lock is not released by the refused run", async () => {
    const host = fakeHost({ lockHeld: true });
    const { receipt, error } = await deployFake(host);
    expect(error?.message).toMatch(/holds the web release lock for stage_target .*Another smoke:web is running/);
    expect(receipt.outcome).toBe("refused");
    expect(host.lines().filter((l) => l === "docker network rm robotmoney-web-lock-stage_target")).toEqual([]);
  });
});

describe("image mode: rollback (smoke:web --host --rollback)", () => {
  test("swaps to the one previous image and keeps the old one as the new previous", async () => {
    const host = fakeHost();
    const deps = imageDeps(host);
    const receipt = await rollbackImage(deps);
    expect(receipt).toMatchObject({
      action: "rollback",
      outcome: "swapped",
      release: { tag: "web-v0.0.9", version: "0.0.9", commit: "cccc333", apiRange: "^0.2.0" },
      oldContainer: { id: OLD_ID, image: OLD_IMAGE },
      newContainer: { id: NEW_ID, image: PREV_IMAGE },
      currentImage: PREV_IMAGE,
      previousImage: OLD_IMAGE,
    });
    expect(receipt.checks.map((c) => c.name)).toEqual(["api-range", "copy", "gap", "public"]);
    expect(receipt.gap!.ms!).toBeLessThanOrEqual(GAP_LIMIT_MS);
    // A rollback builds nothing.
    expect(host.lines().filter((l) => /^docker build\b|rm-verify-web-bundle/.test(l))).toEqual([]);
  });

  test("refuses a previous image whose apiRange the running API does not accept", async () => {
    const host = fakeHost({ api: "0.2.0", previousRelease: { version: "0.0.9", commit: "cccc333", apiRange: "^0.1.0" } });
    const deps = imageDeps(host);
    await expect(rollbackImage(deps)).rejects.toThrow("Refusing: the running API is 0.2.0, outside web-v0.0.9's range ^0.1.0. Nothing was changed.");
    expect(readImageReceipt(deps.receiptDir)).toMatchObject({ action: "rollback", outcome: "refused", apiVersion: "0.2.0" });
    expect(host.lines().filter((l) => /^docker (run -d|create|stop|start)\b/.test(l))).toEqual([]);
  });

  test("refuses when the host holds no previous image", async () => {
    const host = fakeHost({ hasPrevious: false });
    const deps = imageDeps(host);
    await expect(rollbackImage(deps)).rejects.toThrow(/holds no previous image for stage_target/);
    expect(readImageReceipt(deps.receiptDir)?.outcome).toBe("refused");
  });
});

describe("image mode: the first-rollout rule (§4) and swap safety (issue 1632)", () => {
  const KEPT_NAME = `rm_stage_target-website-server-1${FIRST_ROLLOUT_SUFFIX}`;

  test("a first swap from nginx keeps the stopped nginx container as the rollback target, and tags no previous image", async () => {
    const host = fakeHost({ oldIsNginx: true, hasPrevious: false });
    const { receipt, error } = await deployFake(host);
    expect(error).toBeNull();
    expect(receipt).toMatchObject({ outcome: "swapped", oldContainer: { id: OLD_ID, image: NGINX_IMAGE }, currentImage: NEW_IMAGE, previousImage: null });
    const lines = host.lines();
    expect(lines).toContain(`docker rename ${OLD_ID} ${KEPT_NAME}`);
    expect(lines).not.toContain(`docker rm ${OLD_ID}`);
    expect(lines).toContain("docker rmi robotmoney-website:stage_target-previous");
    expect(lines.filter((l) => l.startsWith("docker tag ") && l.endsWith("-previous"))).toEqual([]);
    // The kept container is not a site image, so no image is pruned for it.
    expect(lines).not.toContain(`docker rmi -f ${NGINX_IMAGE}`);
  });

  test("a forced failure on the first swap returns to the running nginx container, and writes no maintenance file into it", async () => {
    const wrong = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ version: "9.9.9", commit: "deadbee" }) });
    servers.push(wrong);
    const host = fakeHost({ oldIsNginx: true, hasPrevious: false });
    const { receipt, error } = await deployFake(host, "^0.2.0", { publicOrigin: `http://127.0.0.1:${wrong.port}` });
    expect(error?.message).toMatch(/The swap to web-v0\.2\.0 failed: .*The previous website-server was started again\./);
    expect(receipt.outcome).toBe("reverted");
    expect(receipt.checks.find((c) => c.name === "revert")).toMatchObject({ ok: true });
    expect(host.state.serving).toBe("old");
    const lines = host.lines();
    // The revert is one host command: remove the new container, give the old one its name back, start it.
    const revert = lines.findLastIndex((l) => l.startsWith("sh -c trap "));
    expect(lines.slice(revert + 1, revert + 4)).toEqual([`docker rm -f ${NEW_ID}`, `docker rename ${OLD_ID} rm_stage_target-website-server-1`, `docker start ${OLD_ID}`]);
    expect(lines.some((l) => l.startsWith("docker exec -i"))).toBe(false);
    expect(lines).not.toContain(`docker rename ${OLD_ID} ${KEPT_NAME}`);
  }, 20_000);

  test("--rollback after the first swap starts the kept nginx container again, and the site image becomes the one previous image", async () => {
    const host = fakeHost({ hasPrevious: false, keptNginx: true, currentTag: OLD_IMAGE });
    const deps = imageDeps(host);
    const receipt = await rollbackImage(deps);
    expect(receipt).toMatchObject({
      action: "rollback",
      outcome: "swapped",
      release: { tag: `web-v${KEPT_RELEASE.version}`, ...KEPT_RELEASE, apiRange: "^0.2.0" },
      oldContainer: { id: OLD_ID, image: OLD_IMAGE },
      newContainer: { id: KEPT_ID, image: NGINX_IMAGE },
      currentImage: NGINX_IMAGE,
      previousImage: OLD_IMAGE,
    });
    expect(receipt.checks.map((c) => [c.name, c.ok])).toEqual([["api-range", true], ["gap", true], ["public", true]]);
    expect(host.state.serving).toBe("kept");
    const lines = host.lines();
    expect(lines.some((l) => l.includes(`--volumes-from ${KEPT_ID}`))).toBe(true);
    const order = [
      index(lines, new RegExp(`^docker stop -t \\d+ ${OLD_ID}$`)),
      index(lines, new RegExp(`^docker start ${KEPT_ID}$`)),
      index(lines, new RegExp(`^docker rename ${KEPT_ID} rm_stage_target-website-server-1$`)),
      index(lines, new RegExp(`^docker tag ${OLD_IMAGE} robotmoney-website:stage_target-previous$`)),
      index(lines, /^docker rmi robotmoney-website:stage_target-current$/),
      index(lines, new RegExp(`^docker rm ${OLD_ID}$`)),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // No throwaway copy, no build: the kept container starts as it was.
    expect(lines.filter((l) => /^docker (build|run -d|create)\b/.test(l))).toEqual([]);
  });

  test("a swap from one site image to another ends the first rollout: the kept nginx container is removed", async () => {
    const host = fakeHost({ keptNginx: true });
    const { error } = await deployFake(host);
    expect(error).toBeNull();
    expect(host.lines()).toContain(`docker rm -f ${KEPT_ID}`);
  });

  test("no previous image and no first-rollout container: --rollback refuses", async () => {
    const host = fakeHost({ hasPrevious: false, keptNginx: false });
    await expect(rollbackImage(imageDeps(host))).rejects.toThrow(/holds no previous image for stage_target .* and no first-rollout container/);
  });

  test("a new container that does not start: the same host command starts the old one again, and the run reverts", async () => {
    const host = fakeHost({ newStartFails: true });
    const { receipt, error } = await deployFake(host);
    expect(error?.message).toMatch(/the new website-server did not start: Error response from daemon/);
    expect(receipt.outcome).toBe("reverted");
    expect(host.state.serving).toBe("old");
    const lines = host.lines();
    const first = index(lines, /^sh -c trap /);
    expect(lines.slice(first + 1, first + 4)).toEqual([`docker stop -t 10 ${OLD_ID}`, `docker start ${NEW_ID}`, `docker start ${OLD_ID}`]);
  });

  test("a throw in step 7 reverts: the old container gets its name back and serves, and the tags are restored", async () => {
    const host = fakeHost({ currentTag: OLD_IMAGE });
    const realRun = host.run.bind(host);
    let renames = 0;
    host.run = async (argv, stdin) => {
      // The second rename (the new container taking the old name) fails.
      if (argv[0] === "docker" && argv[1] === "rename" && ++renames === 2) {
        host.commands.push([...argv]);
        return { code: 1, stdout: "", stderr: "Error response from daemon: name in use" };
      }
      return realRun(argv, stdin);
    };
    const { receipt, error } = await deployFake(host);
    expect(error?.message).toMatch(/The swap to web-v0\.2\.0 failed: naming the new website-server failed .*name in use.*The previous website-server was started again\./);
    expect(receipt.outcome).toBe("reverted");
    expect(receipt.checks.find((c) => c.name === "public")).toMatchObject({ ok: true });
    expect(receipt.checks.find((c) => c.name === "revert")).toMatchObject({ ok: true });
    expect(host.state.serving).toBe("old");
    const lines = host.lines();
    expect(lines).not.toContain(`docker rm ${OLD_ID}`);
    expect(lines).toContain(`docker rename ${OLD_ID} rm_stage_target-website-server-1`);
    // Step 7 never reached the tags, so none is touched.
    expect(lines.filter((l) => l.startsWith("docker tag ") && l.includes("robotmoney-website:"))).toEqual([]);
  });

  test("a throw after the tags moved restores -current and -previous to what they named before the swap", async () => {
    const host = fakeHost({ currentTag: OLD_IMAGE });
    const realRun = host.run.bind(host);
    host.run = async (argv, stdin) => {
      if (argv[0] === "docker" && argv[1] === "rm" && argv[2] === OLD_ID) {
        host.commands.push([...argv]);
        return { code: 1, stdout: "", stderr: "Error response from daemon: removal in progress" };
      }
      return realRun(argv, stdin);
    };
    const { receipt, error } = await deployFake(host);
    expect(error?.message).toMatch(/removing the old website-server failed/);
    expect(receipt.outcome).toBe("reverted");
    const lines = host.lines();
    const moved = index(lines, new RegExp(`^docker tag ${NEW_IMAGE} robotmoney-website:stage_target-current$`));
    expect(moved).toBeGreaterThan(0);
    expect(lines.slice(moved)).toContain(`docker tag ${OLD_IMAGE} robotmoney-website:stage_target-current`);
    expect(lines.slice(moved)).toContain(`docker tag ${PREV_IMAGE} robotmoney-website:stage_target-previous`);
    expect(receipt).toMatchObject({ currentImage: OLD_IMAGE, previousImage: PREV_IMAGE });
  });

  test("a failed deploy never removes an image the host keeps: a candidate equal to -previous stays", async () => {
    const host = fakeHost({ candidateImage: PREV_IMAGE });
    const { receipt, error } = await deployFake(host);
    expect(error?.message).toMatch(/throwaway copy .* failed its check/);
    expect(receipt.outcome).toBe("refused");
    expect(host.lines()).not.toContain(`docker rmi -f ${PREV_IMAGE}`);
  });

  test("a maintenance file that cannot be carried is recorded and never fails the swap", async () => {
    const host = fakeHost({ failing: ["exec"] });
    const { receipt, error } = await deployFake(host);
    expect(error).toBeNull();
    expect(receipt.outcome).toBe("swapped");
  });

  test("--rollback with nothing running starts the stopped container -current names", async () => {
    const host = fakeHost({ allStopped: true, serving: "none", currentTag: OLD_IMAGE });
    const deps = imageDeps(host);
    const receipt = await rollbackImage(deps);
    expect(receipt).toMatchObject({ action: "rollback", outcome: "swapped", oldContainer: { id: OLD_ID }, newContainer: { id: OLD_ID }, currentImage: OLD_IMAGE });
    expect(receipt.checks.map((c) => [c.name, c.ok])).toEqual([["restart", true]]);
    expect(host.state.serving).toBe("old");
    expect(host.lines().filter((l) => /^docker (stop|create|build)\b/.test(l))).toEqual([]);
  });
});

describe("image mode: a server-image change rebuilds the serving bundle through the swap (§5.3, issue 1632)", () => {
  test("the same bundle on the same server image is unchanged: nothing is built", async () => {
    const host = fakeHost();
    const b = signedTestBundle(host.state.newRelease, "^0.2.0");
    host.state.servingSha = b.sha256;
    const deps = imageDeps(host, { allowedSigners: b.allowedSigners });
    const receipt = await deployImage({ bundle: b.bundle, serverImage: "robotmoney-website-server:platform" }, deps);
    expect(receipt.outcome).toBe("unchanged");
    expect(host.lines().filter((l) => /^docker (build|create|stop)\b/.test(l))).toEqual([]);
  });

  test("the same bundle on a new server image is rebuilt FROM it with the serving digest, checked on a copy and swapped in", async () => {
    const host = fakeHost({ serverLayers: ["sha256:l9"] });
    const b = signedTestBundle(host.state.newRelease, "^0.2.0");
    host.state.servingSha = b.sha256;
    const deps = imageDeps(host, { allowedSigners: b.allowedSigners });
    const receipt = await deployImage({ bundle: b.bundle, serverImage: "robotmoney-website-server:platform" }, deps);
    expect(receipt.outcome).toBe("swapped");
    expect(receipt.release?.sha256).toBe(b.sha256);
    expect(receipt.checks.map((c) => [c.name, c.ok])).toEqual([
      ["verify-local", true],
      ["api-range", true],
      ["verify-host", true],
      ["build", true],
      ["copy", true],
      ["gap", true],
      ["public", true],
    ]);
    const build = host.lines().find((l) => l.startsWith("docker build "))!;
    expect(build).toContain(`BUNDLE_SHA256=${b.sha256}`);
    expect(build).toContain(`SERVER_IMAGE=${SERVER_PIN_REPO}:${"4".repeat(64)}`);
  });
});

describe("image mode: pure parts", () => {
  test("the handover script runs in a real shell: stop, start, and the fallback start when the start fails", () => {
    const bin = mkdtempSync(join(tmpdir(), "rm-handover-"));
    roots.push(bin);
    const log = join(bin, "log");
    // A stand-in docker: records its argv, and `start bad` fails.
    writeFileSync(join(bin, "docker"), `#!/bin/sh\necho "$*" >> ${log}\n[ "$1 $2" = "start bad" ] && { echo "no such container: bad" >&2; exit 1; }\nexit 0\n`, { mode: 0o755 });
    const run = (script: string) => {
      writeFileSync(log, "");
      const r = Bun.spawnSync(["sh", "-c", script], { env: { PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
      return { out: r.stdout.toString().trim(), calls: readFileSync(log, "utf8").trim().split("\n") };
    };
    expect(run(handoverScript([["stop", "-t", "10", "old"]], "new", "old"))).toEqual({ out: "started", calls: ["stop -t 10 old", "start new"] });
    expect(run(handoverScript([["stop", "-t", "10", "old"]], "bad", "old"))).toEqual({ out: "failed: no such container: bad", calls: ["stop -t 10 old", "start bad", "start old"] });
    expect(run(handoverScript([], "bad", null))).toEqual({ out: "failed: no such container: bad", calls: ["start bad"] });
    // The body ignores SIGHUP and SIGPIPE, so a dropped link cannot stop it halfway.
    expect(handoverScript([], "x", null).split("\n").filter((l) => l === "trap '' HUP PIPE")).toHaveLength(2);
  });

  test("the replacement keeps the old container's port, networks, aliases, labels, restart, log and health, with the overlay's flags", () => {
    const flags = websiteImageRunFlags(readWebsiteImageService(repoRoot));
    const { create, connect } = replacementCreateArgs(oldInspect(), "next", NEW_IMAGE, flags);
    expect(create.slice(0, 3)).toEqual(["create", "--name", "next"]);
    expect(create.at(-1)).toBe(NEW_IMAGE);
    const labels = create.flatMap((a, i) => (a === "--label" ? [create[i + 1]] : []));
    expect(labels).toEqual(["com.docker.compose.project=rm_stage_target", "com.docker.compose.service=website-server", "robotmoney.instance=stage_target", "robotmoney.smoke=1"]);
    const joined = create.join(" ");
    expect(joined).toContain("--restart unless-stopped");
    expect(joined).toContain("--log-driver json-file --log-opt max-size=10m");
    expect(joined).toContain("--health-cmd wget -q -O /dev/null http://127.0.0.1:8080/ --health-interval 15000ms --health-timeout 5000ms --health-start-period 10000ms --health-retries 3");
    expect(joined).toContain(flags.join(" "));
    expect(joined).toContain("-p 48787:8080");
    expect(joined).toContain("--network rm_stage_target_default --network-alias rm_stage_target-website-server-1 --network-alias website-server ");
    expect(joined).not.toContain(OLD_ID.slice(0, 12));
    expect(connect).toEqual([]);
  });

  test("a loopback binding keeps its address and the port Docker gave the old container", () => {
    const old = oldInspect();
    old.HostConfig.PortBindings = { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] };
    old.NetworkSettings.Ports = { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "32799" }] };
    expect(publicPortBinding(old)).toEqual({ port: 32799, args: ["-p", "127.0.0.1:32799:8080"] });
    old.NetworkSettings.Networks = { a: { Aliases: ["website-server"] }, b: { Aliases: ["web"] } };
    expect(replacementCreateArgs(old, "next", NEW_IMAGE, []).connect).toEqual([["network", "connect", "--alias", "web", "b", "next"]]);
  });

  test("ssh sends each host command as one quoted string over a multiplexed connection", () => {
    expect(sshArgv("deploy@stage", "/s/c", ["sh", "-c", "cat > '/x y'"])).toEqual([
      "ssh", "-o", "BatchMode=yes", "-o", "ControlMaster=auto", "-o", "ControlPath=/s/c", "-o", "ControlPersist=120", "deploy@stage", "--", `sh -c 'cat > '\\''/x y'\\'''`,
    ]);
    expect(shellQuote("robotmoney-website:stage_target-current")).toBe("robotmoney-website:stage_target-current");
    expect(() => sshHost("-oProxyCommand=x")).toThrow(/not an ssh destination/);
  });

  test("names: tags, the lock, release names and instance names", () => {
    expect(siteImageTag("rm_prod", "previous")).toBe("robotmoney-website:rm_prod-previous");
    expect(hostLockName("rm_prod")).toBe("robotmoney-web-lock-rm_prod");
    expect(isReleaseName("web-v1.2.3")).toBe(true);
    expect(isReleaseName("/home/x/robotmoney-web-1.2.3-abc1234.tar.gz")).toBe(false);
    expect(() => assertImageInstance("Bad Name")).toThrow(/must be lower-case/);
    expect(GAP_LIMIT_MS).toBe(3000);
  });

  test("the smoke:web entry selects image mode with --host and still runs the directory mode without it", () => {
    const entry = readFileSync(join(repoRoot, "scripts", "smoke-web.ts"), "utf8");
    expect(entry).toContain('if (values["--host"] !== undefined)');
    expect(entry).toContain('"gh", "release", "download", tag');
    const r = Bun.spawnSync(["bun", join(repoRoot, "scripts", "smoke-web.ts"), "--bundle", "web-v1.0.0"], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("--bundle deploys a signed bundle image and needs --host");
  });

  test("an ssh host needs --origin, so the swap's public check never reads the loopback port (issue 1630); local may omit it", () => {
    const entry = (args: string[]) => Bun.spawnSync(["bun", join(repoRoot, "scripts", "smoke-web.ts"), ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env, RM_SMOKE_STATE_ROOT: "/nonexistent-1630" } });
    for (const args of [
      ["--host", "rm-frontend-prod-1", "--instance", "rm_prod", "--bundle", "web-v1.0.0", "--server-image", "robotmoney-website-server:rm_prod"],
      ["--host", "rm-frontend-prod-1", "--instance", "rm_prod", "--rollback"],
    ]) {
      const r = entry(args);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain("Refusing: an ssh host needs --origin");
    }
    // `--bundle serving` on a host with no website-server for the instance refuses: it never guesses a bundle.
    const serving = entry(["--host", "local", "--instance", "rm_no_such_instance_1630", "--bundle", "serving", "--server-image", "x"]);
    expect(serving.exitCode).toBe(1);
    expect(serving.stderr.toString()).toMatch(/Refusing: (local runs 0 website-server containers for rm_no_such_instance_1630, not one|listing rm_no_such_instance_1630's website-server on local failed)/);
  });
});
