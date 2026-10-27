// The referral coverage manifest (issue 1371, docs/technical/referrals-spec.md §7).
//
// Every vault and router address whose history a report must scan, with its
// ABI version, its block range and its legacy relationships. Historical entries
// survive replacement of the current addresses: an entry is never deleted, it
// gains an `endBlock`. The v0 rmUSDC vault (config.vault) is in it because v0
// history counts toward a depositor's first deposit (spec §2, §7).
//
// An entry whose status is not "confirmed", or whose start block is unknown,
// makes a report's coverage incomplete: the report still runs and shows
// tentative rows, but it never claims a final binding (spec §2 "Incomplete
// legacy coverage blocks a final eligibility decision"). The shipped manifest's
// entries are all "candidate" until the owner supplies the exact deployment
// blocks (spec §11).

export interface ManifestEntry {
  id: string;
  kind: "vault" | "router";
  label: string;
  /** Lowercase 0x address. */
  address: string;
  /** ABI/bytecode version label. */
  abi: string;
  status: "confirmed" | "candidate";
  deploymentBlock: number | null;
  /** First block a scan reads; null while unresolved. */
  startBlock: number | null;
  /** Last block with deposits (a replaced deployment); null while live. */
  endBlock: number | null;
  legacy: { successors: string[] } | null;
}

export interface ReferralManifest {
  schemaVersion: 1;
  chainId: number;
  asset: { symbol: string; address: string; decimals: number };
  carrier: { status: string };
  entries: ManifestEntry[];
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const BLOCK = (v: unknown) => v === null || (Number.isInteger(v) && (v as number) >= 0);

/** Every structural problem with the manifest. Empty when sound. Does not judge completeness. */
export function validateManifest(m: ReferralManifest): string[] {
  const errors: string[] = [];
  if (m.schemaVersion !== 1) errors.push("manifest: schemaVersion must be 1");
  if (!ADDRESS.test(m.asset?.address ?? "")) errors.push("manifest: asset.address must be a lowercase 0x address");
  if (!Number.isInteger(m.asset?.decimals)) errors.push("manifest: asset.decimals must be an integer");
  const ids = new Set<string>();
  const addresses = new Set<string>();
  for (const e of m.entries ?? []) {
    const label = `manifest entry ${JSON.stringify(e.id)}`;
    if (ids.has(e.id)) errors.push(`${label}: duplicate id`);
    ids.add(e.id);
    if (!ADDRESS.test(e.address)) errors.push(`${label}: address must be a lowercase 0x address`);
    if (addresses.has(e.address)) errors.push(`${label}: address listed twice`);
    addresses.add(e.address);
    if (e.kind !== "vault" && e.kind !== "router") errors.push(`${label}: kind must be vault or router`);
    if (e.status !== "confirmed" && e.status !== "candidate") errors.push(`${label}: status must be confirmed or candidate`);
    for (const f of ["deploymentBlock", "startBlock", "endBlock"] as const) {
      if (!BLOCK(e[f])) errors.push(`${label}: ${f} must be null or a non-negative integer`);
    }
    if (e.startBlock !== null && e.endBlock !== null && e.endBlock < e.startBlock) errors.push(`${label}: endBlock before startBlock`);
    if (e.status === "confirmed" && (e.startBlock === null || e.deploymentBlock === null)) {
      errors.push(`${label}: a confirmed entry needs its deployment and start blocks`);
    }
  }
  for (const e of m.entries ?? []) {
    for (const s of e.legacy?.successors ?? []) {
      if (!ids.has(s)) errors.push(`manifest entry ${JSON.stringify(e.id)}: legacy successor ${JSON.stringify(s)} is not an entry`);
    }
  }
  return errors;
}

/** Why the manifest cannot support a complete report; empty when it can. */
export function manifestCoverageGaps(m: ReferralManifest): string[] {
  const gaps: string[] = [];
  for (const e of m.entries) {
    if (e.status !== "confirmed") gaps.push(`${e.id}: deployment not confirmed against the deployed contracts`);
    else if (e.startBlock === null) gaps.push(`${e.id}: start block unresolved`);
  }
  if (m.carrier?.status !== "confirmed") gaps.push("carrier: robotmoney-core's carrier event is not confirmed (core conformance pending)");
  return gaps;
}

/**
 * Previous-revision check: entries are never removed, and an entry's identity
 * (id, kind, address, ABI) never changes. Resolving a candidate's blocks, or
 * closing a replaced deployment with an endBlock, is allowed.
 */
export function validateManifestHistory(prev: ReferralManifest, next: ReferralManifest): string[] {
  const errors = validateManifest(next);
  const byId = new Map(next.entries.map((e) => [e.id, e]));
  for (const old of prev.entries) {
    const cur = byId.get(old.id);
    if (!cur) {
      errors.push(`manifest entry ${JSON.stringify(old.id)}: removed; historical entries survive replacement`);
      continue;
    }
    for (const f of ["kind", "address", "abi"] as const) {
      if (cur[f] !== old[f]) errors.push(`manifest entry ${JSON.stringify(old.id)}: ${f} is immutable`);
    }
    if (old.status === "confirmed") {
      for (const f of ["deploymentBlock", "startBlock"] as const) {
        if (cur[f] !== old[f]) errors.push(`manifest entry ${JSON.stringify(old.id)}: ${f} is immutable once confirmed`);
      }
      if (old.endBlock !== null && cur.endBlock !== old.endBlock) errors.push(`manifest entry ${JSON.stringify(old.id)}: endBlock is immutable once set`);
    }
  }
  return errors;
}

export function entryForAddress(m: ReferralManifest, address: string): ManifestEntry | undefined {
  const a = address.toLowerCase();
  return m.entries.find((e) => e.address === a);
}
