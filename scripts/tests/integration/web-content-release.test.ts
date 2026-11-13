// The web content release's W10 and W11 against a REAL website-server (issues
// 1561 and 1630, D81; release-runbooks.md §12; web-serving-architecture.md
// §5.2).
//
// The host is this machine (smoke-web-image-harness.ts): a Caddy server image
// built from website-server/Dockerfile.caddy trusting a key made here, a
// stand-in api, and a running website-server serving a first signed bundle.
// The runner's own step functions run against it, with ssh as a local shell
// and the control machine's commands run as the runner renders them:
//
//   W10  records the api container and /api/version, then sends the release's
//        bundle with `bun smoke:web`'s image mode (deployArgv);
//   W11  checks /version.json, the website-server's labels against the bundle,
//        every manifest file through the origin by sha256, the platform's
//        header table on / and every sitemap route (the real Caddy answers),
//        and the api unchanged.
//
// Then a second bundle deploys and its live check is forced to fail (one
// sitemap route answers 500 through the injected http): W11 runs
// `bun smoke:web --host local --rollback --origin <origin>` (the real CLI),
// and /version.json is back on the first release. The api container keeps its
// id throughout.
//
// The swap runs the image-mode library (scripts/lib/website-release.ts
// deployImage) in a child process with the harness's allowed-signers file:
// the CLI trusts only the committed key, whose private half no test holds.
// Docker and ssh-keygen are required: without them beforeAll fails, loudly.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  bundlePathOf, deployArgv, rollbackArgv, runDeploy, runLive, type Deps, type ExecResult, type Inputs, type Release, type StepResult, type WebTarget,
} from "../../release/web-release-lib.ts";
import { createImageHost, docker, repoRoot, waitServed, type ImageHost } from "./smoke-web-image-harness.ts";

const FAILING_ROUTE = "/about";
const SITEMAP = (origin: string) => `<?xml version="1.0"?><urlset><url><loc>${origin}/</loc></url><url><loc>${origin}${FAILING_ROUTE}</loc></url></urlset>`;
const C0 = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0";
const C1 = "1111111111111111111111111111111111111111";
const C2 = "2222222222222222222222222222222222222222";

let h: ImageHost;
let scratch = "";
let origin = "";
let target: WebTarget;
const steps: Record<string, StepResult> = {};
const served: Record<string, string> = {};
const apiIds: Record<string, string> = {};
const runs: string[][] = [];

const release = (version: string, commit: string): Release =>
  ({ version, commit, branch: "web/releases-9.9.x", tag: `web-v${version}`, apiCommit: "c0ffee0", base: C0, changed: [], outside: [] });

/** Put a signed bundle where W03 leaves it for this release, and return the release. */
function packed(inputs: Inputs, version: string, commit: string): Release {
  const rel = release(version, commit);
  const from = h.bundle({ version, commit, files: { "sitemap.xml": SITEMAP(origin), "about/index.html": `<!doctype html><title>about ${version}</title>` } });
  const to = bundlePathOf(inputs, rel);
  mkdirSync(join(to, ".."), { recursive: true });
  for (const suffix of ["", ".sha256", ".sha256.sig"]) copyFileSync(`${from}${suffix}`, `${to}${suffix}`);
  return rel;
}

const apiId = (): string => docker(["ps", "-q", "--no-trunc", "--filter", `label=com.docker.compose.project=${h.project}`, "--filter", "label=com.docker.compose.service=api"]);

beforeAll(async () => {
  h = createImageHost("webrel", { version: "9.9.0", commit: C0 });
  await waitServed(h, { version: "9.9.0", commit: C0 });
  scratch = mkdtempSync(join(tmpdir(), "rm-web-release-"));
  origin = `http://127.0.0.1:${h.serving().port}`;
  const state = join(scratch, "state");
  // readServing reads the instance's stack record for its compose project.
  mkdirSync(join(state, h.instance), { recursive: true });
  writeFileSync(join(state, h.instance, "stack-state.json"), JSON.stringify({ project: h.project }));
  target = {
    name: "integration", rmEnv: "stage", host: "local", home: scratch, instance: h.instance, publicOrigin: origin,
    stateRoot: state, serverImage: h.serverImage, env: {},
  };
  const files = new Map<string, string>();
  const inputs: Inputs = { commits: [], target, stage: target, dryRun: false, workDir: join(scratch, "run"), signingKey: "(unused)", controlStateRoot: join(scratch, "control") };

  const shell = async (_host: string, remote: string): Promise<ExecResult> => {
    const p = Bun.spawn(["sh", "-c", remote], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, status] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { status, stdout, stderr };
  };
  const realHttp = async (url: string) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    return { status: r.status, body: await r.text(), headers: Object.fromEntries(r.headers.entries()) };
  };
  /** The control machine's commands, as the runner renders them: smoke:web's deploy through the library (the harness's trust root), its rollback through the real CLI. */
  const exec = (argv: string[]): ExecResult => {
    runs.push(argv);
    const at = (flag: string) => argv[argv.indexOf(flag) + 1]!;
    if (argv.slice(0, 3).join(" ") !== "bun run smoke:web") throw new Error(`no exec ${argv.join(" ")} from W10 or W11`);
    const env = { ...process.env, RM_SMOKE_STATE_ROOT: inputs.controlStateRoot };
    const r = argv.includes("--rollback")
      ? Bun.spawnSync(["bun", join(repoRoot, "scripts", "smoke-web.ts"), ...argv.slice(3)], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" })
      : Bun.spawnSync(["bun", "-e", `
          import { deployImage } from ${JSON.stringify(join(repoRoot, "scripts", "lib", "website-release.ts"))};
          import { localHost } from ${JSON.stringify(join(repoRoot, "scripts", "lib", "website-host.ts"))};
          const host = localHost();
          try {
            await deployImage({ bundle: ${JSON.stringify(at("--bundle"))}, serverImage: ${JSON.stringify(at("--server-image"))} }, {
              host, instance: ${JSON.stringify(at("--instance"))}, receiptDir: ${JSON.stringify(join(inputs.controlStateRoot, "web-image", h.instance))},
              repoRoot: ${JSON.stringify(repoRoot)}, allowedSigners: ${JSON.stringify(h.allowedSigners)}, publicOrigin: ${JSON.stringify(at("--origin"))},
            });
          } finally { host.close(); }
        `], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
    return { status: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  const deps = (http = realHttp): Deps => ({
    git: () => { throw new Error("no git call from W10 or W11"); },
    gh: () => { throw new Error("no gh call from W10 or W11"); },
    exec,
    ssh: shell,
    http,
    async httpBytes(url) {
      const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      return { status: r.status, bytes: new Uint8Array(await r.arrayBuffer()) };
    },
    readFile: (p) => { try { return files.get(p) ?? readFileSync(p, "utf8"); } catch { return undefined; } },
    readBytes: (p) => { try { return new Uint8Array(readFileSync(p)); } catch { return undefined; } },
    writeFile: (p, t) => { files.set(p, t); },
    clock: () => Date.now(),
    sleep: (ms) => Bun.sleep(ms),
    log: (l) => console.log(`[web-content-release] ${l}`),
  });
  const site = async () => { const s = await h.served(); return `${s?.version}-${s?.commit}`; };

  apiIds.before = apiId();
  const first = packed(inputs, "9.9.1", C1);
  steps.deploy1 = await runDeploy(first, inputs, deps());
  steps.live1 = await runLive(first, inputs, deps());
  served.first = await site();
  apiIds.first = apiId();

  const second = packed(inputs, "9.9.2", C2);
  steps.deploy2 = await runDeploy(second, inputs, deps());
  served.deployed2 = await site();
  const failing = async (url: string) => (url.endsWith(FAILING_ROUTE) ? { status: 500, body: "forced", headers: {} } : realHttp(url));
  steps.live2 = await runLive(second, inputs, deps(failing));
  served.rolledBack = await site();
  apiIds.after = apiId();
}, 600_000);

afterAll(() => {
  h?.dispose();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}, 120_000);

describe("a web content release's W10 and W11 against a real website-server", () => {
  test("W10 sends the bundle with smoke:web's image mode, --origin included, and the swap serves it", () => {
    expect(steps.deploy1, steps.deploy1?.detail).toMatchObject({ state: "done" });
    expect(runs[0]!.slice(0, 7)).toEqual(["bun", "run", "smoke:web", "--host", "local", "--instance", h.instance]);
    expect(runs[0]!.slice(-4)).toEqual(["--server-image", h.serverImage, "--origin", origin]);
    expect(basename(runs[0]![8]!)).toBe(`robotmoney-web-9.9.1-${C1}.tar.gz`);
    expect(served.first).toBe(`9.9.1-${C1}`);
  });

  test("W11 passes: labels, every manifest file by sha256, the header table on every sitemap route, the api unchanged", () => {
    expect(steps.live1, steps.live1?.detail).toMatchObject({ state: "done" });
    // index.html, _shell.html, assets/app.js, version.json, sitemap.xml and about/index.html.
    expect(steps.live1!.detail).toContain("6 file(s) served as the manifest lists, the header table holds on / and every sitemap route (each 200)");
  });

  test("the api container keeps its id across both swaps and the rollback", () => {
    expect(apiIds.before).not.toBe("");
    expect(apiIds.first).toBe(apiIds.before!);
    expect(apiIds.after).toBe(apiIds.before!);
  });

  test("a forced live-check failure runs the real smoke:web --rollback and the first release serves again", () => {
    expect(steps.deploy2, steps.deploy2?.detail).toMatchObject({ state: "done" });
    expect(served.deployed2).toBe(`9.9.2-${C2}`);
    expect(steps.live2!.state).toBe("failed");
    expect(steps.live2!.detail).toContain(`GET ${FAILING_ROUTE} answered 500`);
    expect(steps.live2!.detail).toContain("rolled back to the previous image (bun smoke:web --rollback)");
    expect(steps.live2!.detail).toContain("ship the fix as web-v9.9.3");
    expect(runs.at(-1)).toEqual(rollbackArgv(target));
    expect(served.rolledBack).toBe(`9.9.1-${C1}`);
  });

  test("deployArgv is the command W10 ran", () => {
    expect(runs[0]).toEqual(deployArgv(target, runs[0]![8]!));
  });
});
