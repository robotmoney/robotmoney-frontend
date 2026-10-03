// Deployment manifests of the one-deployment-scheme contract set: new keys
// read, old keys refused, gateway and router taken from the manifest.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  OLD_MANIFEST_KEYS,
  fileNamesFromStageTable,
  loadDeploymentManifests,
  overviewRowsFromDeployment,
  parseDeploymentSet,
  resolveDeployment,
  riskLabelForName,
} from "../src/chain/deployment-manifest.ts";

const DIR = join(import.meta.dir, "../../test-fixtures/deployments/new-keys");
const files = (): Record<string, any> =>
  Object.fromEntries(readdirSync(DIR).map((f) => [f, JSON.parse(readFileSync(join(DIR, f), "utf8"))]));

test("new-key manifests give four vaults, the gateway and the router it carries", () => {
  const set = loadDeploymentManifests(DIR);
  expect(set.chainId).toBe(918453);
  expect(set.vaults.map((v) => v.slug)).toEqual(["rmusdc", "rmproto", "rmagent", "rmrwa"]);
  expect(set.gateway).toBe(files()["gateway.json"].gateway);
  expect(set.router).toBe(files()["router.json"].router);
  expect(set.gatewayRouter).toBe(set.router);
  expect(set.registry).toBe(files()["registry.json"].registry);
});

test("rmAGENT is paused with no assets, rmRWA is a basket row with deSPXA, rmPROTO holds wETH and cbBTC", () => {
  const by = Object.fromEntries(loadDeploymentManifests(DIR).vaults.map((v) => [v.slug, v]));
  expect(by.rmagent.paused).toBe(true);
  expect(by.rmagent.assets).toEqual([]);
  expect(by.rmrwa.kind).toBe("basket");
  expect(by.rmrwa.assets.map((a) => a.symbol)).toEqual(["deSPXA"]);
  expect(by.rmproto.assets.map((a) => a.symbol)).toEqual(["wETH", "cbBTC"]);
  expect(by.rmusdc.kind).toBe("lending");
});

test("overview rows carry paused status and the gateway and router, with no made-up figures", () => {
  const rows = overviewRowsFromDeployment(loadDeploymentManifests(DIR)) as any[];
  const agent = rows.find((r) => r.slug === "rmagent");
  expect(agent.status).toBe("paused");
  expect(agent.tvlUsd).toBeNull();
  expect(agent.contracts.gateway).toBe(files()["gateway.json"].gateway);
  expect(agent.contracts.router).toBe(files()["router.json"].router);
});

test("a manifest with an old key is refused", () => {
  const f = files();
  f["vault.json"].morpho_adapter = f["vault.json"].aave_adapter;
  expect(OLD_MANIFEST_KEYS).toContain("morpho_adapter");
  expect(() => parseDeploymentSet(f)).toThrow(/removed manifest key "morpho_adapter"/);
});

test("a gateway without its router, or with a different one, is refused", () => {
  const a = files();
  delete a["gateway.json"].gateway_router;
  expect(() => parseDeploymentSet(a)).toThrow(/gateway_router/);
  const b = files();
  b["gateway.json"].gateway_router = "0x" + "99".repeat(20);
  expect(() => parseDeploymentSet(b)).toThrow(/router/);
  const c = files();
  c["gateway.json"].gateway_router = "0x" + "00".repeat(20);
  expect(() => parseDeploymentSet(c)).toThrow(/zero address/);
});

test("chain ids must agree across manifests", () => {
  const f = files();
  f["router.json"].chain_id = 8453;
  expect(() => parseDeploymentSet(f)).toThrow(/chain_id/);
});

test("the stage table names the files; version other than 1 is refused", () => {
  const table = {
    version: 1,
    stages: [
      { name: "vault", manifest: "deployments/<chain>/vault.json", vault: "USDC" },
      { name: "registry", manifest: "deployments/<chain>/registry.json", vault: null },
      { name: "router", manifest: "deployments/<chain>/router.json", vault: null },
      { name: "gateway", manifest: "deployments/<chain>/gateway.json", vault: null },
      { name: "proto", manifest: "deployments/<chain>/protocol-asset-vault.json", vault: "PROTO" },
      { name: "agent", manifest: "deployments/<chain>/agent-token-vault.json", vault: "AGENT" },
      { name: "rwa", manifest: "deployments/<chain>/rwa-basket-vault.json", vault: "RWA" },
    ],
  };
  expect(fileNamesFromStageTable(table).vault.RWA).toBe("rwa-basket-vault.json");
  expect(() => fileNamesFromStageTable({ ...table, version: 2 })).toThrow(/version/);
});

test("risk labels follow the registered names", () => {
  expect(riskLabelForName("Robot Money USDC")).toBe("STABLE_YIELD");
  expect(riskLabelForName("Robot Money Protocol")).toBe("VOLATILE");
  expect(riskLabelForName("Robot Money Agent Tokens")).toBe("SPECULATIVE");
  expect(riskLabelForName("Robot Money RWA")).toBe("SPECULATIVE");
  expect(riskLabelForName("RM USDC")).toBeNull();
});

test("DEPLOYMENT_MANIFEST_DIR unset reads nothing; set reads the manifests", () => {
  expect(resolveDeployment({}).gateway).toBeNull();
  expect(resolveDeployment({ DEPLOYMENT_MANIFEST_DIR: DIR }).gateway).toBe(files()["gateway.json"].gateway);
});
