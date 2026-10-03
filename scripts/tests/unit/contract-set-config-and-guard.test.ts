// One-deployment-scheme (frontend 1103), what the other suites leave open:
//   - config.vault.gateway / router consumption (manifest first, then env, then
//     null), run in a child process because config reads env at import.
//   - the old-manifest-key repo guard: every scanned root, a clean root, and the
//     wiring into the repo-guards workflow (the required CI job).
//   - the Playwright vault-pages spec names all four vaults; running it needs a
//     browser, so that criterion is a skipIf test with the exact command.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const root = join(import.meta.dir, "../../..");
const FIX = join(root, "test-fixtures/deployments/new-keys");
const rd = (p: string) => readFileSync(join(root, p), "utf8");

// ── config.vault.gateway / router ────────────────────────────────────────────
function configVault(env: Record<string, string>) {
  const probe = `const { config } = await import(${JSON.stringify(join(root, "backend/src/config.ts"))});
    console.log(JSON.stringify({ gateway: config.vault.gateway, router: config.vault.router, address: config.vault.address }));`;
  const r = Bun.spawnSync(["bun", "--no-env-file", "-e", probe], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      DATABASE_URL: "postgres://u:p@127.0.0.1:1/x",
      WORKER_DATABASE_URL: "postgres://u:p@127.0.0.1:1/x",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
}
const gw = JSON.parse(readFileSync(join(FIX, "gateway.json"), "utf8"));
const rt = JSON.parse(readFileSync(join(FIX, "router.json"), "utf8"));
const vt = JSON.parse(readFileSync(join(FIX, "vault.json"), "utf8"));

describe("config.vault.gateway and router", () => {
  test("come from the manifest keys gateway and router, lowercase", () => {
    const r = configVault({ DEPLOYMENT_MANIFEST_DIR: FIX });
    expect(r.code).toBe(0);
    const v = JSON.parse(r.out);
    expect(v.gateway).toBe(gw.gateway.toLowerCase());
    expect(v.router).toBe(rt.router.toLowerCase());
    expect(v.address).toBe(vt.vault.toLowerCase());
  });

  test("the manifest wins over GATEWAY_ADDRESS and ROUTER_ADDRESS", () => {
    const r = configVault({
      DEPLOYMENT_MANIFEST_DIR: FIX,
      GATEWAY_ADDRESS: "0x" + "ab".repeat(20),
      ROUTER_ADDRESS: "0x" + "cd".repeat(20),
    });
    const v = JSON.parse(r.out);
    expect(v.gateway).toBe(gw.gateway.toLowerCase());
    expect(v.router).toBe(rt.router.toLowerCase());
  });

  test("with no manifest the env values are used, and with neither they are null", () => {
    const env = JSON.parse(configVault({ GATEWAY_ADDRESS: "0x" + "AB".repeat(20), ROUTER_ADDRESS: "0x" + "CD".repeat(20) }).out);
    expect(env.gateway).toBe("0x" + "ab".repeat(20));
    expect(env.router).toBe("0x" + "cd".repeat(20));
    const none = JSON.parse(configVault({}).out);
    expect(none.gateway).toBeNull();
    expect(none.router).toBeNull();
  });

  test("a manifest dir with an old key stops the config from loading (no silent fallback to env)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-old-"));
    writeFileSync(join(dir, "vault.json"), JSON.stringify({ chain_id: 1, vault: "0x" + "21".repeat(20), morpho_adapter: "0x" + "22".repeat(20) }));
    const r = configVault({ DEPLOYMENT_MANIFEST_DIR: dir, GATEWAY_ADDRESS: "0x" + "ab".repeat(20) });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("morpho_adapter");
  });
});

// ── repo guard ───────────────────────────────────────────────────────────────
const guard = join(root, "scripts/checks/check-old-manifest-keys.ts");
const runGuard = (dir: string) => Bun.spawnSync(["bun", guard, dir], { stdout: "pipe", stderr: "pipe" });
const plant = (dir: string, rel: string, body: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
};
const OLD = JSON.stringify({ vault: "0x1", morpho_adapter: "0x2" });

describe("old-manifest-key guard", () => {
  for (const sub of ["test-fixtures/deployments/a/vault.json", "deployments/base-8453/vault.json", "frontend/public/data/v.json", "shared-fixtures/m.json"]) {
    test(`exits 1 naming the file for a key planted under ${sub.split("/")[0]}`, () => {
      const dir = mkdtempSync(join(tmpdir(), "guard-"));
      plant(dir, sub, OLD);
      const r = runGuard(dir);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain(sub);
    });
  }

  test("exits 0 on a root holding only the new-key fixtures", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-clean-"));
    for (const f of ["vault.json", "gateway.json", "router.json", "registry.json"]) plant(dir, `test-fixtures/deployments/new-keys/${f}`, readFileSync(join(FIX, f), "utf8"));
    const r = runGuard(dir);
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toBe("");
  });

  test("ignores the old key outside the scanned roots and in non-JSON files", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-skip-"));
    plant(dir, "docs/x.json", OLD);
    plant(dir, "test-fixtures/notes.md", OLD);
    plant(dir, "test-fixtures/node_modules/p/v.json", OLD);
    expect(runGuard(dir).exitCode).toBe(0);
  });

  test("is wired into the repo-guards workflow, which runs on every pull request without a path filter", () => {
    expect(JSON.parse(rd("package.json")).scripts["check:old-manifest-keys"]).toBe("bun scripts/checks/check-old-manifest-keys.ts");
    const wf = rd(".github/workflows/repo-guards.yml");
    expect(wf).toMatch(/run: bun run check:old-manifest-keys/);
    const on = wf.slice(wf.indexOf("\non:"), wf.indexOf("\njobs:"));
    expect(on).toContain("pull_request:");
    expect(on).not.toContain("paths:");
  });
});

// ── Playwright vault-pages spec ──────────────────────────────────────────────
describe("vault-pages Playwright spec", () => {
  const spec = rd("frontend/test/browser/vault-pages.spec.ts");

  test("names all four vaults and reads the registered names and risk labels from the shared fixtures", () => {
    for (const s of ["rmUSDC", "rmPROTO", "rmAGENT", "rmRWA", "test-fixtures/vault-set", "overview.json", "vault-names.json", "VAULT_NAMES"]) {
      expect(spec).toContain(s);
    }
    const names = JSON.parse(rd("test-fixtures/vault-set/vault-names.json")).names;
    expect(names.map((n: any) => n.slug).sort()).toEqual(["rmagent", "rmproto", "rmrwa", "rmusdc"]);
  });

  test.skipIf(process.env.RUN_PLAYWRIGHT !== "1")(
    "all four vault cards render (needs a browser; run: bunx playwright test frontend/test/browser/vault-pages.spec.ts)",
    () => {
      const r = Bun.spawnSync(["bunx", "playwright", "test", "frontend/test/browser/vault-pages.spec.ts"], { cwd: root });
      expect(r.exitCode).toBe(0);
    },
    600_000,
  );
});
