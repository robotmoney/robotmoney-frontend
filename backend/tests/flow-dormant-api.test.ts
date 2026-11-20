import { expect, test } from "bun:test";
import { handleFlowHealth } from "../src/api/routes/flow-health.ts";
import { handleFlowVault } from "../src/api/routes/flow-vault.ts";
import { handleFlowPosition } from "../src/api/routes/flow-position.ts";
import { handleFlowRequest } from "../src/api/routes/flow-request.ts";
import { handleFlowEvents } from "../src/api/routes/flow-events.ts";
import { handleFlowPrices } from "../src/api/routes/flow-prices.ts";
import { handleFlowOwner } from "../src/api/routes/flow-owner.ts";
import { handleFlowOwnerClaims } from "../src/api/routes/flow-owner-claims.ts";
import { handleFlowRequestHistory } from "../src/api/routes/flow-request-history.ts";
import { handleFlowTransactions } from "../src/api/routes/flow-transactions.ts";

const owner = "0x" + "a".repeat(40);
const get = (path: string) => new Request(`http://localhost${path}`);
const u = (path: string) => new URL(`http://localhost${path}`);

test("with the FLOW settings empty every flow route is dormant and makes no RPC or network call", async () => {
  const saved = { q: process.env.FLOW_QUEUE_ADDRESS, f: process.env.FLOW_FUND_ADDRESS };
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => { fetches++; throw new Error("no network expected"); }) as unknown as typeof fetch;
  try {
    process.env.FLOW_QUEUE_ADDRESS = "";
    process.env.FLOW_FUND_ADDRESS = "";
    const health = await handleFlowHealth(get("/api/public/flow/health"), "9.9.9.1");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: "idle", enabled: false, reason: "flow index is not configured" });
    const data: Response[] = [
      await handleFlowVault(get("/v"), "9.9.9.2"),
      await handleFlowPosition(get("/p"), owner, "9.9.9.3"),
      await handleFlowRequest(get("/r"), "1", "9.9.9.4"),
      await handleFlowEvents(get("/e"), u("/e"), "9.9.9.5"),
      await handleFlowPrices(get("/pr"), u("/pr"), "9.9.9.6"),
      await handleFlowOwner(get("/o"), u("/o"), owner, "9.9.9.7"),
      await handleFlowOwnerClaims(get("/c"), u("/c"), owner, "9.9.9.8"),
      await handleFlowRequestHistory(get("/h"), u("/h"), "1", "9.9.9.9"),
      await handleFlowTransactions(get("/t"), u("/t?action=deposit&owner=" + owner + "&amount=1"), "9.9.9.10"),
    ];
    for (const res of data) {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ enabled: false });
    }
    expect(fetches).toBe(0);
  } finally {
    globalThis.fetch = realFetch;
    if (saved.q === undefined) delete process.env.FLOW_QUEUE_ADDRESS; else process.env.FLOW_QUEUE_ADDRESS = saved.q;
    if (saved.f === undefined) delete process.env.FLOW_FUND_ADDRESS; else process.env.FLOW_FUND_ADDRESS = saved.f;
  }
});
