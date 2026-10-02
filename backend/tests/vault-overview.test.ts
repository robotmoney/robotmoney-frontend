// The manifest-derived four-vault overview route (frontend 1103): rows from
// the deployment manifests, the gateway and router exposed, and no route
// (null, so 404) when no manifest is configured.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { emptyDeploymentSet, loadDeploymentManifests } from "../src/chain/deployment-manifest.ts";
import { buildVaultsOverview } from "../src/chain/vault-overview.ts";
import { getRobotmoneyVaults } from "../src/api/routes/dashboards.ts";

const DIR = join(import.meta.dir, "../../test-fixtures/deployments/new-keys");
const set = () => loadDeploymentManifests(DIR);

test("no manifest configured: no overview (the route answers 404)", () => {
  expect(buildVaultsOverview(emptyDeploymentSet())).toBeNull();
});

test("the overview carries four manifest rows with the gateway and router", () => {
  const dto = buildVaultsOverview(set(), {}, new Date("2026-10-02T00:00:00Z"))!;
  expect(dto.asOf).toBe("2026-10-02T00:00:00.000Z");
  expect(dto.network.chainId).toBe(918453);
  expect(dto.contracts.gateway).toBe(set().gateway);
  expect(dto.contracts.router).toBe(set().router);
  expect(dto.vaults.map((r) => r.slug)).toEqual(["rmusdc", "rmproto", "rmagent", "rmrwa"]);
  const agent = dto.vaults.find((r) => r.slug === "rmagent")!;
  expect(agent.status).toBe("paused");
  expect(agent.tvlUsd).toBeNull();
  expect((agent.contracts as any).gateway).toBe(set().gateway);
});

test("the handler reads rmUSDC's figures and leaves the other rows null", async () => {
  const dto: any = await getRobotmoneyVaults(set(), (async () => ({ tvlUsd: 1, sharePrice: 1 })) as any);
  expect(dto.vaults.find((r: any) => r.slug === "rmusdc").tvlUsd).toBe(1);
  expect(dto.vaults.find((r: any) => r.slug === "rmproto").tvlUsd).toBeNull();
});

test("a failed economics read leaves null figures, never an error", async () => {
  const dto: any = await getRobotmoneyVaults(set(), (async () => { throw new Error("rpc down"); }) as any);
  expect(dto.vaults.every((r: any) => r.tvlUsd === null)).toBe(true);
});

test("the handler returns null with an empty deployment", async () => {
  expect(await getRobotmoneyVaults(emptyDeploymentSet())).toBeNull();
});
