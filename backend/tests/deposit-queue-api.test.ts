// The public deposit queue reads, against a migrated Postgres holding an
// indexed window and a fake Base node answering the queue and fund views.
// Every response is versioned (schemaVersion 1) and names the indexed block,
// hash and time it describes. Contract views are read at that block. The
// event histories are read from the canonical index only, in chain order, so
// the same index always yields the same history, including after a replay.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { config } from "../src/config.ts";
import { sql } from "../src/db/client.ts";
import { flowBindDeployment, flowRecord, flowRewind } from "../src/pipeline/stores/flow-index.ts";
import type { FlowHeader, FlowLog } from "../src/chain/flow-indexer.ts";
import { handleFlowHealth, FLOW_MAX_AGE_SECONDS } from "../src/api/routes/flow-health.ts";
import { handleFlowVault } from "../src/api/routes/flow-vault.ts";
import { handleFlowPosition } from "../src/api/routes/flow-position.ts";
import { handleFlowRequest } from "../src/api/routes/flow-request.ts";
import { handleFlowRequestHistory } from "../src/api/routes/flow-request-history.ts";
import { handleFlowOwnerClaims } from "../src/api/routes/flow-owner-claims.ts";
import { handleFlowOwner } from "../src/api/routes/flow-owner.ts";
import { handleFlowPrices } from "../src/api/routes/flow-prices.ts";
import { useCleanDatabase } from "./support/clean-db.ts";

useCleanDatabase(import.meta.file);

const QUEUE = `0x${"1".repeat(40)}`;
const FUND = `0x${"2".repeat(40)}`;
const OWNER = `0x${"3".repeat(40)}`;
const KEEPER = `0x${"4".repeat(40)}`;
const word = (value: bigint | string) => (typeof value === "string" ? value.replace(/^0x/, "").toLowerCase() : value.toString(16)).padStart(64, "0");
const encoded = (...values: bigint[]) => `0x${values.map(word).join("")}`;
const blockHash = (n: number) => `0x${word(BigInt(n))}`;
const TIME = 1_700_000_000;
const header = (n: number): FlowHeader => ({ number: n, hash: blockHash(n), timestamp: TIME + n * 2 });
const freshness = { block: 1000, hash: blockHash(1000), time: new Date((TIME + 2000) * 1000).toISOString() };
const timeOf = (n: number) => new Date((TIME + n * 2) * 1000).toISOString();

const TOPIC = {
  DepositRequested: "0xb8cbb91f85c0ecbb8b541805846bc3a6e090a8147b47523c51583a4815daebf9",
  DepositFilled: "0xae1f583816a37727fa407fb842920ab50ad6f9b9e7c9b025ac764a96343fe317",
  Settled: "0x8ecc624c6f11fc84fecb7269245980bab9d25af8b2548d1d47212d16e53de860",
  SharesDelivered: "0xdfe275799fb4d958ef7eb4fa3c86cdca5a4999fd0b8941d39653fd13f1c22bae",
  CreditAdded: "0x4a39100d222c6c07af4e59c449c4643191784bcc65a9b1427f7c6e0018a75b3e",
};
const log = (blockNumber: number, logIndex: number, topics: string[], data: string): FlowLog => ({ blockNumber, blockHash: blockHash(blockNumber), logIndex, transactionHash: `0x${word(BigInt(blockNumber * 10 + logIndex))}`, address: QUEUE, topics, data });
const LOGS = [
  log(990, 0, [TOPIC.DepositRequested, `0x${word(7n)}`, `0x${word(OWNER)}`, `0x${word(OWNER)}`], encoded(100n, 3n)),
  log(995, 0, [TOPIC.DepositFilled, `0x${word(7n)}`, `0x${word(1n)}`, `0x${word(2n)}`], encoded(60n, 55n, 5000n)),
  log(995, 1, [TOPIC.Settled, `0x${word(2n)}`, `0x${word(KEEPER)}`], encoded(10n ** 36n, 0n, 0n, 60n, 55n, 0n, 0n)),
  log(998, 0, [TOPIC.SharesDelivered, `0x${word(OWNER)}`, `0x${word(KEEPER)}`], encoded(55n, 60n)),
  log(998, 1, [TOPIC.CreditAdded, `0x${word(OWNER)}`], encoded(1n, 0n)),
];
const HEADERS = Array.from({ length: 21 }, (_, i) => header(980 + i));

// The queue and fund views, by selector, as the release ABI encodes them.
const params = Array.from({ length: 21 }, () => 0n); params[1] = 10n; params[18] = 5n;
const request = Array.from({ length: 20 }, () => 0n);
request[0] = BigInt(OWNER); request[2] = 3n; request[3] = 100n; request[6] = 25n; request[7] = 3600n; request[9] = 900n; request[11] = 5000n;
const VIEWS: Record<string, string> = {
  "0x2d39d674": encoded(100n, 90n), "0x18160ddd": encoded(80n), "0x79502c55": encoded(200n, 50n, 25n, 0n),
  "0x6ad0690a": encoded(1n, 0n, 0n, 0n, 0n, 5n, 100n), "0x76671808": encoded(3n), "0x71d53fe4": encoded(...params),
  "0x9f163905": encoded(32n, 1n, 5000n), "0x7d53d9c1": encoded(32n, 1n, 0n, 1n, 5000n, 1n, 2n, 3n, 3000n, 60n, 0n, 4n, 60n),
  "0x2eee90e3": encoded(7n, 64n, 1n, 33n), "0x648c691a": encoded(100n), "0x07a2d13a": encoded(123n),
  "0x402d267d": encoded(1n), "0xc63d75b6": encoded(2n), "0xd905777e": encoded(3n), "0x75807250": encoded(4n, 5n),
  "0xddbb34b6": encoded(6n), "0x70a08231": encoded(7n), "0xce4a7043": encoded(8n),
  "0xc58343ef": encoded(...request), "0x1a313202": encoded(1n), "0x26c6f96c": encoded(40n), "0x995ea21a": encoded(60n),
};

let server: ReturnType<typeof Bun.serve>;
const saved = { url: config.baseRpcUrl, rate: process.env.BASE_RPC_MAX_CALLS_PER_SEC, queue: process.env.FLOW_QUEUE_ADDRESS, fund: process.env.FLOW_FUND_ADDRESS };
const blockTags = new Set<string>();
beforeAll(async () => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const input = await req.json();
    const answer = (call: { id: number; method: string; params: unknown[] }) => {
      if (call.method === "eth_getBlockByNumber") { blockTags.add(String(call.params[0])); return { jsonrpc: "2.0", id: call.id, result: { hash: blockHash(parseInt(String(call.params[0]), 16)) } }; }
      if (call.method !== "eth_call") throw new Error(`unexpected RPC ${call.method}`);
      blockTags.add(String(call.params[1]));
      const result = VIEWS[(call.params[0] as { data: string }).data.slice(0, 10)];
      return result ? { jsonrpc: "2.0", id: call.id, result } : { jsonrpc: "2.0", id: call.id, error: { code: 3, message: "execution reverted" } };
    };
    return Response.json(Array.isArray(input) ? input.map(answer) : answer(input));
  } });
  config.baseRpcUrl = `http://127.0.0.1:${server.port}`;
  process.env.BASE_RPC_MAX_CALLS_PER_SEC = "0";
  process.env.FLOW_QUEUE_ADDRESS = QUEUE;
  process.env.FLOW_FUND_ADDRESS = FUND;
  await sql.begin(async (tx) => {
    await flowBindDeployment(tx, 8453, QUEUE, FUND);
    await flowRecord(tx, 8453, HEADERS, LOGS);
  });
});
afterAll(() => {
  config.baseRpcUrl = saved.url;
  for (const [key, value] of [["BASE_RPC_MAX_CALLS_PER_SEC", saved.rate], ["FLOW_QUEUE_ADDRESS", saved.queue], ["FLOW_FUND_ADDRESS", saved.fund]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  server.stop(true);
});

let ip = 0;
const get = async (route: (req: Request, url: URL) => Promise<Response>, path: string, status = 200) => {
  const url = new URL(`http://localhost${path}`);
  const response = await route(new Request(url), url);
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return response.json();
};
const nextIp = () => `deposit-queue-api-${ip++}`;

test("health reports the indexed watermark and turns stale past the freshness budget", async () => {
  const now = (TIME + 2000 + 30) * 1000;
  expect(await get((req) => handleFlowHealth(req, nextIp(), () => now), "/api/public/flow/health")).toEqual({ schemaVersion: 1, status: "ok", indexedThrough: freshness, ageSeconds: 30, maxAgeSeconds: FLOW_MAX_AGE_SECONDS });
  const late = now + (FLOW_MAX_AGE_SECONDS + 1) * 1000;
  expect((await get((req) => handleFlowHealth(req, nextIp(), () => late), "/api/public/flow/health")).status).toBe("stale");
});

test("vault and holdings are read at the indexed block", async () => {
  blockTags.clear();
  const body = await get((req) => handleFlowVault(req, nextIp()), "/api/public/flow/vault");
  expect(body.schemaVersion).toBe(1);
  expect(body.indexedThrough).toEqual(freshness);
  expect([...blockTags]).toEqual(["0x3e8"]);
  expect(body.vault).toMatchObject({ navUsdc: "100", navObservedAt: "90", totalShares: "80", tvlCapUsdc: "200", roomAtLastGoodNavUsdc: "100", perDepositCapUsdc: "50", exitFeeBps: "25", idleUsdc: "7", epoch: "3", settleableAt: "100", cancelCutoff: "85", pricePerMillionSharesUsdc: "123", priceBinding: false });
  expect(body.vault.holdings).toEqual([{ index: 0, kind: "0", active: true, capBps: "5000", adapter: `0x${word(1n).slice(24)}`, token: `0x${word(2n).slice(24)}`, pool: `0x${word(3n).slice(24)}`, held: "33", targetBps: "5000" }]);
});

test("owner position reports claimable, credit and held shares", async () => {
  const body = await get((req) => handleFlowPosition(req, OWNER, nextIp()), `/api/public/flow/owners/${OWNER}/position`);
  expect(body).toEqual({ schemaVersion: 1, indexedThrough: freshness, position: { owner: OWNER, claimableDepositUsdc: "1", claimableDepositShares: "2", claimableRedeemShares: "3", creditUsdc: "4", creditShares: "5", ledgerShares: "6", walletShares: "7", queuedShares: "8" } });
});

test("request status reports pending and claimable allocation with its snapshotted terms", async () => {
  const body = await get((req) => handleFlowRequest(req, "7", nextIp()), "/api/public/flow/requests/7");
  expect(body).toEqual({ schemaVersion: 1, indexedThrough: freshness, request: { requestId: "7", owner: OWNER, kind: "deposit", amountUnit: "usdc-base-units", status: "pending", amount: "100", pending: "40", claimable: "60", epoch: "3", cancelCutoff: "85", originalEpochSettleableAt: "100", exitFeeBps: "25", minHold: "3600", createdAt: "900", expiresAt: "5000" } });
});

test("price history lists settlement prices in chain order", async () => {
  const body = await get((req, url) => handleFlowPrices(req, url, nextIp()), "/api/public/flow/prices");
  expect(body).toEqual({ schemaVersion: 1, indexedThrough: freshness, priceScale: (10n ** 36n).toString(), prices: [{ block: 995, time: timeOf(995), logIndex: 1, transactionHash: LOGS[2]!.transactionHash, settlementId: "2", sharePrice: (10n ** 36n).toString() }] });
});

test("allocation and claim history are deterministic and survive a replay unchanged", async () => {
  const read = async () => ({
    requests: await get((req, url) => handleFlowOwner(req, url, OWNER, nextIp()), `/api/public/flow/owners/${OWNER}`),
    history: await get((req, url) => handleFlowRequestHistory(req, url, "7", nextIp()), "/api/public/flow/requests/7/history"),
    claims: await get((req, url) => handleFlowOwnerClaims(req, url, OWNER, nextIp()), `/api/public/flow/owners/${OWNER}/claims`),
  });
  const first = await read();
  expect(first.requests.requests.map((r: { event: { name: string } }) => r.event.name)).toEqual(["DepositRequested"]);
  expect(first.history).toEqual({
    schemaVersion: 1, indexedThrough: freshness, attribution: "request-events-only", nextCursor: { block: 995, logIndex: 0 },
    events: [
      { block: 990, time: timeOf(990), logIndex: 0, transactionHash: LOGS[0]!.transactionHash, event: { name: "DepositRequested", args: { requestId: "7", owner: OWNER, sender: OWNER, usdc: "100", epoch: "3" } } },
      { block: 995, time: timeOf(995), logIndex: 0, transactionHash: LOGS[1]!.transactionHash, event: { name: "DepositFilled", args: { requestId: "7", claimId: "1", settlementId: "2", usdc: "60", shares: "55", unlockAt: "5000" } } },
    ],
  });
  expect(first.claims).toEqual({
    schemaVersion: 1, indexedThrough: freshness, nextCursor: { block: 998, logIndex: 1 },
    claims: [
      { block: 998, time: timeOf(998), logIndex: 0, transactionHash: LOGS[3]!.transactionHash, event: { name: "SharesDelivered", args: { owner: OWNER, caller: KEEPER, shares: "55", usdc: "60" } } },
      { block: 998, time: timeOf(998), logIndex: 1, transactionHash: LOGS[4]!.transactionHash, event: { name: "CreditAdded", args: { owner: OWNER, usdc: "1", shares: "0" } } },
    ],
  });
  const page = await get((req, url) => handleFlowOwnerClaims(req, url, OWNER, nextIp()), `/api/public/flow/owners/${OWNER}/claims?afterBlock=998&afterLogIndex=0`);
  expect(page.claims.map((c: { logIndex: number }) => c.logIndex)).toEqual([1]);
  expect(await read()).toEqual(first);
  await sql.begin(async (tx) => { await flowRewind(tx, 8453, 985); await flowRecord(tx, 8453, HEADERS.slice(6), LOGS); });
  expect(await read()).toEqual(first);
});

test("an unconfigured or rebound index serves no state", async () => {
  process.env.FLOW_FUND_ADDRESS = `0x${"9".repeat(40)}`;
  try {
    expect((await get((req) => handleFlowHealth(req, nextIp()), "/api/public/flow/health", 503)).status).toBe("unavailable");
    await get((req) => handleFlowVault(req, nextIp()), "/api/public/flow/vault", 503);
    await get((req) => handleFlowRequest(req, "7", nextIp()), "/api/public/flow/requests/7", 503);
    await get((req, url) => handleFlowOwnerClaims(req, url, OWNER, nextIp()), `/api/public/flow/owners/${OWNER}/claims`, 503);
  } finally { process.env.FLOW_FUND_ADDRESS = FUND; }
});
