// Deployment manifests of the one-deployment-scheme contract set.
//
// Core writes one JSON file per deploy stage under deployments/<chain>/ and
// lists them in scripts/deploy/stage-table.json (version 1). This module reads
// that directory and answers: which vaults exist, which are paused, and which
// addresses the gateway, the router and the registry have. No address is
// written in code. A manifest that still carries a removed key, or a gateway
// whose router is empty, is refused: a half-migrated set must fail loudly.
//
// PURE except loadDeploymentManifests(), which only reads files.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type VaultKey = "USDC" | "PROTO" | "AGENT" | "RWA";

export const VAULT_SLUG: Record<VaultKey, string> = {
  USDC: "rmusdc",
  PROTO: "rmproto",
  AGENT: "rmagent",
  RWA: "rmrwa",
};

// Names the registry holds for each vault (core Deploy*Vault scripts). The
// indexer's risk_label is derived from these (core 1434).
export const REGISTERED_NAME: Record<VaultKey, string> = {
  USDC: "Robot Money USDC",
  PROTO: "Robot Money Protocol",
  AGENT: "Robot Money Agent Tokens",
  RWA: "Robot Money RWA",
};

export type RiskLabel = "STABLE_YIELD" | "VOLATILE" | "SPECULATIVE";

export const RISK_LABEL: Record<VaultKey, RiskLabel> = {
  USDC: "STABLE_YIELD",
  PROTO: "VOLATILE",
  AGENT: "SPECULATIVE",
  RWA: "SPECULATIVE",
};

// Keys the new set no longer writes. Their presence means a stale manifest.
export const OLD_MANIFEST_KEYS = ["morpho_adapter"] as const;

// Stage-table version 1 file names. A stage-table.json beside the manifests
// overrides these (see fileNamesFromStageTable), so a rename in core needs no
// edit here.
export interface ManifestFileNames {
  vault: Record<VaultKey, string>;
  registry: string;
  router: string;
  gateway: string;
}

export const DEFAULT_FILE_NAMES: ManifestFileNames = {
  vault: {
    USDC: "vault.json",
    PROTO: "protocol-asset-vault.json",
    AGENT: "agent-token-vault.json",
    RWA: "rwa-basket-vault.json",
  },
  registry: "registry.json",
  router: "router.json",
  gateway: "gateway.json",
};

export interface StageTableLike {
  version?: number;
  stages?: Array<{ name?: string; manifest?: string; vault?: string | null }>;
}

const baseName = (template: string): string => template.split("/").pop() ?? template;

export function fileNamesFromStageTable(table: StageTableLike): ManifestFileNames {
  if (table.version !== 1) throw new Error(`stage-table version ${String(table.version)} is not supported (expected 1)`);
  const stages = Array.isArray(table.stages) ? table.stages : [];
  const byName = (n: string): string => {
    const s = stages.find((x) => x.name === n);
    if (!s?.manifest) throw new Error(`stage-table has no manifest for stage "${n}"`);
    return baseName(s.manifest);
  };
  const vault = {} as Record<VaultKey, string>;
  for (const key of Object.keys(VAULT_SLUG) as VaultKey[]) {
    const s = stages.find((x) => x.vault === key);
    if (!s?.manifest) throw new Error(`stage-table has no stage for vault ${key}`);
    vault[key] = baseName(s.manifest);
  }
  return { vault, registry: byName("registry"), router: byName("router"), gateway: byName("gateway") };
}

export interface BasketAsset {
  symbol: string;
  token: string;
  pool: string | null;
  poolFee: number | null;
}

export interface VaultDeployment {
  key: VaultKey;
  slug: string;
  registeredName: string;
  riskLabel: RiskLabel;
  address: string;
  // Lending vault (rmUSDC) or token basket (rmPROTO, rmAGENT, rmRWA).
  kind: "lending" | "basket";
  // null when the manifest does not say (rmUSDC has no paused key).
  paused: boolean | null;
  registered: boolean | null;
  // Configured basket assets, not holdings. Empty for rmUSDC.
  assets: BasketAsset[];
  chainId: number | null;
}

export interface DeploymentSet {
  chainId: number | null;
  vaults: VaultDeployment[];
  registry: string | null;
  router: string | null;
  gateway: string | null;
  // The router the gateway carries. Must equal `router`.
  gatewayRouter: string | null;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function addr(file: string, obj: Record<string, unknown>, key: string, required: boolean): string | null {
  const v = obj[key];
  if (v === undefined || v === null) {
    if (required) throw new Error(`${file}: missing key "${key}"`);
    return null;
  }
  if (typeof v !== "string" || !ADDRESS_RE.test(v)) throw new Error(`${file}: key "${key}" is not an address`);
  if (v.toLowerCase() === ZERO_ADDRESS) throw new Error(`${file}: key "${key}" is the zero address`);
  return v.toLowerCase();
}

function rejectOldKeys(file: string, obj: Record<string, unknown>): void {
  for (const k of OLD_MANIFEST_KEYS) {
    if (k in obj) throw new Error(`${file}: carries the removed manifest key "${k}"`);
  }
}

function chainIdOf(file: string, obj: Record<string, unknown>): number | null {
  const v = obj.chain_id;
  if (v === undefined) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) throw new Error(`${file}: chain_id is not a positive integer`);
  return v;
}

function parseAssets(file: string, raw: unknown): BasketAsset[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${file}: "assets" is not an array`);
  return raw.map((a, i) => {
    const o = (a ?? {}) as Record<string, unknown>;
    const token = addr(`${file}.assets[${i}]`, o, "token", true) as string;
    if (typeof o.symbol !== "string" || !o.symbol) throw new Error(`${file}.assets[${i}]: missing symbol`);
    const pool = addr(`${file}.assets[${i}]`, o, "pool", false);
    const fee = o.pool_fee;
    return { symbol: o.symbol, token, pool, poolFee: typeof fee === "number" ? fee : null };
  });
}

// Parse the manifests of one chain, given file name -> parsed JSON. A missing
// file leaves its part null (a set under construction is readable), a bad or
// stale file throws.
export function parseDeploymentSet(
  files: Record<string, unknown>,
  names: ManifestFileNames = DEFAULT_FILE_NAMES,
): DeploymentSet {
  const obj = (file: string): Record<string, unknown> | null => {
    const v = files[file];
    if (v === undefined) return null;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${file}: not a JSON object`);
    const o = v as Record<string, unknown>;
    rejectOldKeys(file, o);
    return o;
  };

  let chainId: number | null = null;
  const seeChain = (file: string, o: Record<string, unknown>) => {
    const c = chainIdOf(file, o);
    if (c === null) return;
    if (chainId !== null && chainId !== c) throw new Error(`${file}: chain_id ${c} differs from ${chainId} in another manifest`);
    chainId = c;
  };

  const vaults: VaultDeployment[] = [];
  for (const key of Object.keys(VAULT_SLUG) as VaultKey[]) {
    const file = names.vault[key];
    const o = obj(file);
    if (!o) continue;
    seeChain(file, o);
    const basket = key !== "USDC";
    vaults.push({
      key,
      slug: VAULT_SLUG[key],
      registeredName: REGISTERED_NAME[key],
      riskLabel: RISK_LABEL[key],
      address: addr(file, o, "vault", true) as string,
      kind: basket ? "basket" : "lending",
      paused: typeof o.paused === "boolean" ? o.paused : null,
      registered: typeof o.registered === "boolean" ? o.registered : null,
      assets: basket ? parseAssets(file, o.assets) : [],
      chainId: chainIdOf(file, o),
    });
  }

  let registry: string | null = null;
  const reg = obj(names.registry);
  if (reg) {
    seeChain(names.registry, reg);
    registry = addr(names.registry, reg, "registry", true);
  }

  let router: string | null = null;
  const rt = obj(names.router);
  if (rt) {
    seeChain(names.router, rt);
    router = addr(names.router, rt, "router", true);
  }

  let gateway: string | null = null;
  let gatewayRouter: string | null = null;
  const gw = obj(names.gateway);
  if (gw) {
    seeChain(names.gateway, gw);
    gateway = addr(names.gateway, gw, "gateway", true);
    // Router-first: a gateway without its router is the old defect (core 1493).
    gatewayRouter = addr(names.gateway, gw, "gateway_router", true);
  }
  if (router && gatewayRouter && router !== gatewayRouter) {
    throw new Error(`gateway carries router ${gatewayRouter} but the router manifest says ${router}`);
  }

  return { chainId, vaults, registry, router, gateway, gatewayRouter };
}

// Read deployments/<chain>/ from disk. A stage-table.json in the directory
// names the files; otherwise stage-table version 1 defaults apply.
export function loadDeploymentManifests(dir: string): DeploymentSet {
  const read = (file: string): unknown => {
    const p = join(dir, file);
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined;
  };
  const table = read("stage-table.json") as StageTableLike | undefined;
  const names = table ? fileNamesFromStageTable(table) : DEFAULT_FILE_NAMES;
  const files: Record<string, unknown> = {};
  const wanted = [...Object.values(names.vault), names.registry, names.router, names.gateway];
  for (const f of wanted) {
    const v = read(f);
    if (v !== undefined) files[f] = v;
  }
  return parseDeploymentSet(files, names);
}

export function emptyDeploymentSet(): DeploymentSet {
  return { chainId: null, vaults: [], registry: null, router: null, gateway: null, gatewayRouter: null };
}

// DEPLOYMENT_MANIFEST_DIR names deployments/<chain>/. Unset means no manifest
// (the legacy env path); a set but unreadable dir throws, never falls back.
export function resolveDeployment(env: Record<string, string | undefined> = process.env): DeploymentSet {
  const dir = env.DEPLOYMENT_MANIFEST_DIR;
  if (!dir) return emptyDeploymentSet();
  return loadDeploymentManifests(dir);
}

// Registered vault name to risk label. Unknown names return null: a vault the
// frontend cannot classify is shown without a label, never as STABLE_YIELD.
export function riskLabelForName(name: string): RiskLabel | null {
  const key = (Object.keys(REGISTERED_NAME) as VaultKey[]).find((k) => REGISTERED_NAME[k] === name);
  return key ? RISK_LABEL[key] : null;
}

// The raw overview rows the web client normalises (lib/vault-data.js
// normalizeOverview). Figures nobody read stay null. A paused vault with no
// reading is reported paused, never given a made-up TVL.
export function overviewRowsFromDeployment(
  set: DeploymentSet,
  reads: Partial<Record<VaultKey, { tvlUsd: number | null; sharePrice: number | null }>> = {},
): Array<Record<string, unknown>> {
  return set.vaults.map((v) => {
    const r = reads[v.key];
    return {
      slug: v.slug,
      availability: "live",
      status: v.paused === true ? "paused" : "active",
      address: v.address,
      kind: v.kind,
      registeredName: v.registeredName,
      riskLabel: v.riskLabel,
      tvlUsd: r?.tvlUsd ?? null,
      sharePrice: r?.sharePrice ?? null,
      contracts: { vault: v.address, router: set.router, registry: set.registry, gateway: set.gateway },
      assets: v.assets,
    };
  });
}
