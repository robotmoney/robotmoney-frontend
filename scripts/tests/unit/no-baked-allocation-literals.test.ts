// Guard (live-data contract #50): the buyback table, token-metrics, and holdings
// numbers the allocation/tokenomics views used to BAKE are now served live from
// /api/dashboards/{buybacks,token-metrics,wallet-sleeves,allocation}. This grep
// guard fails loudly if any of those baked literals reappears anywhere in the
// static frontend tree (a regression would silently re-introduce fabricated
// point-in-time numbers presented as live).
//
// This is an ADDITION to the executed backend handler tests
// (backend/tests/api/dashboards-live.test.ts) — not a substitute. It reads the
// real on-disk frontend/public tree and asserts, so it is genuine coverage that
// runs with no DB/network under the test-coverage policy.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../..");
const publicDir = join(repoRoot, "frontend", "public");

// Walk every static asset the site ships (skip the committed data/ archive: it
// holds legitimate historical swarm snapshot JSON with its own value_usd
// figures, which are NOT the removed allocation baked literals).
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (p === join(publicDir, "data")) continue;
      out.push(...walk(p));
    } else {
      out.push(p);
    }
  }
  return out;
}

const files = walk(publicDir);
const contents = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

// The 10 real buyback tx hashes that used to be baked as basescan links in
// views/allocation.html — now they live only in the backend seed + API payload.
const BAKED_TX_HASHES = [
  "0xa19a086682db8ff57a94e8f594bb542c8e4ba1d8f79bf7ad48717be0587ffa37",
  "0x9ce840624ce3742bca40f6b672587dfa1ad85ac40476ecb7cb71938a170319bc",
  "0x8dc090ca0ec59882d541dffd52adbe64adbdba4166dd63a230722d2ea0b29266",
  "0x1e09868aa284f8a969f7a85a11758e896b786f5f78daf8b503274b2828209361",
  "0x79594aaa2a4b39bdcbc19ba9f39834963d0f00599b4437e17a517503f996450f",
  "0x9364ec11ec2543438b2c1efaee79aad6ecc2ef42606ca9efa9f8378ac4837eac",
  "0xd63e11167880ef5ca9d7dfeb2e361b355e93aa01317ccb9ab5bdf5918168eb74",
  "0xe6d8138395fb5815157cf1197570dd26c10f4fd3c3792e08fa9f38956811ec33",
  "0x81cf52a3f723c48a65c67999b5b4417a67b67687125aec29ba255246a6eba39f",
  "0x3c9718e37624c0de8b5e295b3e8a9cf5dc98dcd0d08cbad395551c2ce6f8eab9",
];

// Baked scalar literals removed from the allocation/tokenomics views (totals +
// per-holding figures that are now fetched live).
const BAKED_SCALARS = [
  "1.149114", // total WETH spent (buyback footer)
  "178.82M", // total ROBOTMONEY bought back
  "6499.61M", // baked ROBOTMONEY holding amount
  "25,081.3083", // baked BNKR holding amount
  "9,037.405", // baked USDC holding amount
  "71,526", // baked total holdings value
];

function offenders(needle: string): string[] {
  const hits: string[] = [];
  for (const [f, text] of contents) if (text.includes(needle)) hits.push(f.replace(publicDir + "/", ""));
  return hits;
}

describe("frontend static tree carries no removed baked allocation literals", () => {
  test("no baked buyback tx hash is hard-coded in any static asset", () => {
    for (const h of BAKED_TX_HASHES) expect({ hash: h, in: offenders(h) }).toEqual({ hash: h, in: [] });
  });

  test("no baked allocation/tokenomics scalar is hard-coded in any static asset", () => {
    for (const s of BAKED_SCALARS) expect({ scalar: s, in: offenders(s) }).toEqual({ scalar: s, in: [] });
  });

  test("no baked basescan buyback-tx link survives in the allocation view", () => {
    const alloc = contents.get(join(publicDir, "views", "allocation.html")) ?? "";
    expect(alloc).not.toContain("basescan.org/tx/0x");
  });
});
