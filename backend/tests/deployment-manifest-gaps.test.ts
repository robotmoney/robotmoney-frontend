// Gaps around the manifest reader (frontend 1103): missing and partial sets,
// bad values, each row's figures staying null, and the stage-table override.
// DB-free: the reader imports no config.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildVaultsOverview,
} from "../src/chain/vault-overview.ts";
import {
  loadDeploymentManifests,
  overviewRowsFromDeployment,
  parseDeploymentSet,
  riskLabelForName,
  resolveDeployment,
} from "../src/chain/deployment-manifest.ts";

const DIR = join(import.meta.dir, "../../test-fixtures/deployments/new-keys");
const files = (): Record<string, any> =>
  Object.fromEntries(readdirSync(DIR).map((f) => [f, JSON.parse(readFileSync(join(DIR, f), "utf8"))]));

test("an empty manifest dir reads as an empty set, so no overview is served", () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-empty-"));
  const set = loadDeploymentManifests(dir);
  expect(set.vaults).toEqual([]);
  expect(set.gateway).toBeNull();
  expect(buildVaultsOverview(set)).toBeNull();
});

test("a set under construction (one vault only) is readable and lists just that vault", () => {
  const f = files();
  const set = parseDeploymentSet({ "vault.json": f["vault.json"] });
  expect(set.vaults.map((v) => v.slug)).toEqual(["rmusdc"]);
  expect(set.router).toBeNull();
});

test("a malformed manifest file fails loudly rather than reading as empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-bad-"));
  writeFileSync(join(dir, "vault.json"), "{ not json");
  expect(() => loadDeploymentManifests(dir)).toThrow();
});

test("a non-address or zero-address vault is refused", () => {
  const f = files();
  f["vault.json"].vault = "0x123";
  expect(() => parseDeploymentSet(f)).toThrow(/not an address/);
  const g = files();
  g["protocol-asset-vault.json"].vault = "0x" + "00".repeat(20);
  expect(() => parseDeploymentSet(g)).toThrow(/zero address/);
});

test("an old key is refused in every manifest file, not only vault.json", () => {
  // libs.json is not a stage manifest the reader loads.
  for (const file of Object.keys(files()).filter((x) => x !== "libs.json")) {
    const f = files();
    f[file].morpho_adapter = "0x" + "11".repeat(20);
    expect(() => parseDeploymentSet(f), file).toThrow(/morpho_adapter/);
  }
});

test("the new-key fixtures themselves carry no old key", () => {
  for (const [file, obj] of Object.entries(files())) expect(Object.keys(obj), file).not.toContain("morpho_adapter");
});

test("paused-empty rmAGENT and the basket rows give null figures, never made-up ones", () => {
  const rows = overviewRowsFromDeployment(parseDeploymentSet(files())) as any[];
  expect(rows).toHaveLength(4);
  for (const r of rows) {
    expect(r.tvlUsd).toBeNull();
    expect(r.sharePrice).toBeNull();
  }
  const by = Object.fromEntries(rows.map((r) => [r.slug, r]));
  expect(by.rmagent.status).toBe("paused");
  expect(by.rmagent.assets).toEqual([]);
  expect(by.rmrwa.status).toBe("active");
  expect(by.rmrwa.kind).toBe("basket");
  expect(by.rmusdc.status).toBe("active");
});

test("a reading is used for its own vault only", () => {
  const rows = overviewRowsFromDeployment(parseDeploymentSet(files()), { USDC: { tvlUsd: 7, sharePrice: 1.01 } }) as any[];
  expect(rows.filter((r) => r.tvlUsd !== null).map((r) => r.slug)).toEqual(["rmusdc"]);
});

test("each row's registered name and risk label are the shared fixture's", () => {
  const names = JSON.parse(readFileSync(join(import.meta.dir, "../../test-fixtures/vault-set/vault-names.json"), "utf8")).names;
  const rows = overviewRowsFromDeployment(parseDeploymentSet(files())) as any[];
  for (const n of names) {
    const r = rows.find((x) => x.slug === n.slug);
    expect(r.registeredName).toBe(n.name);
    expect(r.riskLabel).toBe(n.risk_label);
    expect(riskLabelForName(n.name)).toBe(n.risk_label);
  }
  expect(riskLabelForName("robot money usdc")).toBeNull();
});

test("a stage-table.json beside the manifests renames the files read", () => {
  const dir = mkdtempSync(join(tmpdir(), "mf-table-"));
  const f = files();
  const table = {
    version: 1,
    stages: [
      { name: "vault", manifest: "deployments/<chain>/usdc-vault.json", vault: "USDC" },
      { name: "registry", manifest: "deployments/<chain>/registry.json", vault: null },
      { name: "router", manifest: "deployments/<chain>/router.json", vault: null },
      { name: "gateway", manifest: "deployments/<chain>/gateway.json", vault: null },
      { name: "proto", manifest: "deployments/<chain>/protocol-asset-vault.json", vault: "PROTO" },
      { name: "agent", manifest: "deployments/<chain>/agent-token-vault.json", vault: "AGENT" },
      { name: "rwa", manifest: "deployments/<chain>/rwa-basket-vault.json", vault: "RWA" },
    ],
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stage-table.json"), JSON.stringify(table));
  for (const [name, obj] of Object.entries(f)) writeFileSync(join(dir, name === "vault.json" ? "usdc-vault.json" : name), JSON.stringify(obj));
  expect(loadDeploymentManifests(dir).vaults.map((v) => v.slug)).toEqual(["rmusdc", "rmproto", "rmagent", "rmrwa"]);
  // The old name is not read once the table renames it.
  writeFileSync(join(dir, "stage-table.json"), JSON.stringify({ ...table, stages: table.stages.filter((s) => s.name !== "rwa") }));
  expect(() => loadDeploymentManifests(dir)).toThrow(/no stage for vault RWA/);
});

test("a set DEPLOYMENT_MANIFEST_DIR that does not exist reads as empty rather than inventing addresses", () => {
  const set = resolveDeployment({ DEPLOYMENT_MANIFEST_DIR: join(tmpdir(), "does-not-exist-" + Date.now()) });
  expect(set.vaults).toEqual([]);
  expect(set.gateway).toBeNull();
});
