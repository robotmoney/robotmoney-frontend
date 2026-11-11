// The web content release's host steps against a REAL running stack (issue
// 1561, D81; release-runbooks.md §12).
//
// One `bun smoke --local blank --migrate` boot of its own instance stands in for
// production. A web release's W09 to W11 then run their own commands
// (scripts/release/web-release-lib.ts runCheckout, runDeploy, runLive) through a
// local shell in place of ssh, exactly as the runner renders them for the host:
//
//   W09  clones the release checkout from a variant tree (smoke-web-harness.ts:
//        this checkout's source with another frontend version, tagged web-v*),
//        detaches it at the tag and runs bun install --frozen-lockfile;
//   W10  records the api and worker containers and /api/version, then runs
//        `bun run smoke:web` from that checkout;
//   W11  checks /version.json, that each changed served file is served byte for
//        byte as web/current holds it, every sitemap route, a headless browser
//        (the real ./web-browser-smoke.ts) on the base routes, and the api and
//        workers.
//
// Then a second version deploys and its live check is forced to fail (one
// sitemap route answers 500 through the injected http): W11 runs
// `bun run smoke:web --rollback` and /version.json is back on the first site.
// Across all of it the api and every worker keep their container id and the
// /api/version body stays byte-for-byte the same.
//
// Docker is required: a host without it fails the boot in beforeAll, loudly.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContractVersion } from "../../lib/api-range.ts";
import { readStackState } from "../../lib/smoke-state.ts";
import {
  runCheckout, runDeploy, runLive, type Deps, type ExecResult, type Inputs, type PageReport, type Release, type StepResult, type WebTarget,
} from "../../release/web-release-lib.ts";
import { runBrowserSmoke } from "../../release/web-browser-smoke.ts";
import { BOOT_TIMEOUT_MS, bootFailureReport, harness, spawnBoot, teardown, type BootHarness, type RunningBoot } from "./smoke-boot-harness.ts";
import { servedSite, serviceContainers, variantTree, type ServiceContainer, type VariantTree } from "./smoke-web-harness.ts";

const API_VERSION = readContractVersion();
const FAILING_ROUTE = "/swarm";
const SERVED_CHANGES = ["frontend/package.json", "frontend/public/index.html", "frontend/public/sitemap.xml", "frontend/public/views/regime.html"];

let h: BootHarness;
let boot: RunningBoot;
let variant: VariantTree;
let scratch = "";
let webPort = 0;

let first: Release;
let second: Release;
const steps: Record<string, StepResult> = {};
let served: Record<string, string> = {};
let apiBodies: Record<string, string> = {};
let containers: Record<string, Record<string, ServiceContainer>> = {};
const browserReports: PageReport[] = [];

const backend = (all: Record<string, ServiceContainer>): Record<string, string> =>
  Object.fromEntries(Object.entries(all).filter(([s]) => s === "api" || s.startsWith("worker")).map(([s, c]) => [s, c.id]));

function gitIn(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.name=web-release-test", "-c", "user.email=web-release-test@invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** Tag the variant tree's HEAD web-v<version> after setting frontend/package.json's version; the release it makes. */
function release(version: string): Release {
  const pkgPath = join(variant.dir, "frontend", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
  if (pkg.version !== version) {
    writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
    gitIn(variant.dir, ["commit", "-qam", `web ${version}`]);
  }
  const tag = `web-v${version}`;
  gitIn(variant.dir, ["tag", "-a", tag, "-m", tag]);
  const commit = gitIn(variant.dir, ["rev-parse", "HEAD"]);
  // W11 compares the served copies of the changed files the site serves; the package manifest is a build input, skipped.
  return { version, commit, branch: "web/releases-9.9.x", tag, apiCommit: "", base: "", changed: SERVED_CHANGES, outside: [] };
}

beforeAll(async () => {
  h = harness("webrel");
  boot = spawnBoot(h);
  const code = await boot.exited;
  if (code !== 0) throw new Error(`bun smoke exited ${code}:\n${bootFailureReport(boot)}`);
  webPort = readStackState(h.paths)!.webPort;
  variant = variantTree("9.9.1", `^${API_VERSION}`);
  scratch = mkdtempSync(join(tmpdir(), "rm-web-release-"));

  const target: WebTarget = {
    name: "integration", rmEnv: "stage", host: "(local)", home: h.env.HOME!, instance: h.instance,
    publicOrigin: `http://127.0.0.1:${webPort}`, checkout: join(scratch, "rm-web"), stateRoot: h.root, cloneFrom: variant.dir,
    // The harness's hermetic environment (its state root, PATH, Docker), added to every command's env -i.
    env: h.env,
  };
  const shell = async (_host: string, remote: string): Promise<ExecResult> => {
    const p = Bun.spawn(["sh", "-c", remote], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { status, stdout, stderr };
  };
  const realHttp = async (url: string) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    return { status: r.status, body: await r.text() };
  };
  const files = new Map<string, string>();
  const realBytes = async (url: string) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
  };
  const deps = (http = realHttp): Deps => ({
    // W11 reads the release tree (does a changed path exist; routes.js): the variant tree holds the release commits.
    git: (a) => {
      if (a[0] !== "show" && a[0] !== "cat-file") throw new Error(`no git ${a[0]} call from W09-W11`);
      const r = Bun.spawnSync(["git", ...a], { cwd: variant.dir, stdout: "pipe", stderr: "pipe" });
      return { status: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    },
    gh: () => { throw new Error("no gh call from W09-W11"); },
    exec: () => { throw new Error("no exec call from W09-W11"); },
    ssh: shell,
    http,
    httpBytes: realBytes,
    browser: async (origin, routes, budgetMs) => {
      const reports = await runBrowserSmoke(origin, routes, budgetMs);
      browserReports.push(...reports);
      return reports;
    },
    readFile: (p) => files.get(p),
    writeFile: (p, t) => { files.set(p, t); },
    clock: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
    log: (l) => console.log(`[web-content-release] ${l}`),
  });
  const inputs: Inputs = { commits: [], target, stage: target, dryRun: false, workDir: scratch };
  const site = async () => { const s = await servedSite(webPort); return `${s.version}-${s.commit}`; };
  const apiBody = async () => (await fetch(`http://127.0.0.1:${webPort}/api/version`)).text();

  served.boot = await site();
  apiBodies.before = await apiBody();
  containers.before = serviceContainers(h.project);

  first = release("9.9.1");
  steps.checkout1 = await runCheckout(first, target, deps());
  steps.deploy1 = await runDeploy(first, inputs, deps());
  steps.live1 = await runLive(first, inputs, deps());
  served.first = await site();
  apiBodies.first = await apiBody();
  containers.first = serviceContainers(h.project);

  second = release("9.9.2");
  steps.checkout2 = await runCheckout(second, target, deps());
  steps.deploy2 = await runDeploy(second, inputs, deps());
  served.deployed2 = await site();
  const failing = async (url: string) => (url.endsWith(FAILING_ROUTE) ? { status: 500, body: "forced" } : realHttp(url));
  steps.live2 = await runLive(second, inputs, deps(failing));
  served.rolledBack = await site();
  apiBodies.after = await apiBody();
  containers.after = serviceContainers(h.project);
}, BOOT_TIMEOUT_MS);

afterAll(() => {
  if (h) teardown(h, boot);
  variant?.dispose();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}, 300_000);

describe("a web content release's host steps on a running stack", () => {
  test("W09 clones {home}/rm-web, detaches it at the tag and installs", () => {
    expect(steps.checkout1, steps.checkout1?.detail).toMatchObject({ state: "done" });
    expect(steps.checkout1!.detail).toContain(`detached at ${first.tag}`);
    expect(steps.checkout2, steps.checkout2?.detail).toMatchObject({ state: "done" });
  });

  test("W10 and W11 switch /version.json to the new version", () => {
    expect(steps.deploy1, steps.deploy1?.detail).toMatchObject({ state: "done" });
    expect(steps.live1, steps.live1?.detail).toMatchObject({ state: "done" });
    expect(served.first!.startsWith("9.9.1-")).toBe(true);
    expect(first.commit.startsWith(served.first!.slice("9.9.1-".length))).toBe(true);
    expect(served.first).not.toBe(served.boot);
  });

  test("W11 compared the changed served files with web/current and loaded the base routes in a real browser", () => {
    expect(steps.live1!.detail).toContain("3 changed file(s) are served as deployed (1 not served)");
    expect(browserReports.map((r) => r.route)).toEqual(expect.arrayContaining(["/", "/regime", "/early-access"]));
    expect(steps.live1!.detail).toMatch(/the browser smoke passed on \d+ page\(s\)/);
  });

  test("the api and worker container ids and the /api/version body stay identical", () => {
    const before = backend(containers.before!);
    expect(Object.keys(before)).toContain("api");
    expect(Object.keys(before).some((s) => s.startsWith("worker"))).toBe(true);
    expect(backend(containers.first!)).toEqual(before);
    expect(backend(containers.after!)).toEqual(before);
    expect(apiBodies.first).toBe(apiBodies.before!);
    expect(apiBodies.after).toBe(apiBodies.before!);
  });

  test("a forced live-check failure rolls /version.json back to the previous site and fails the step", () => {
    expect(steps.deploy2, steps.deploy2?.detail).toMatchObject({ state: "done" });
    expect(served.deployed2!.startsWith("9.9.2-")).toBe(true);
    expect(steps.live2!.state).toBe("failed");
    expect(steps.live2!.detail).toContain(`GET ${FAILING_ROUTE} answered 500`);
    expect(steps.live2!.detail).toContain("rolled back to the previous site (bun run smoke:web --rollback)");
    expect(steps.live2!.detail).toContain("ship the fix as web-v9.9.3");
    expect(served.rolledBack).toBe(served.first!);
  });
});
