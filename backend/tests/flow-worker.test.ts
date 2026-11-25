import { expect, test } from "bun:test";
import { refreshFlowIndex, resetFlowIdleLog } from "../src/worker/handlers/flow-index.ts";

async function withEnv(values: Record<string, string | undefined>, run: () => Promise<void>) {
  const keys = Object.keys(values);
  const saved = keys.map((k) => process.env[k]);
  try {
    for (const k of keys) { if (values[k] === undefined) delete process.env[k]; else process.env[k] = values[k]; }
    await run();
  } finally {
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
  }
}

test("unconfigured job is an idle no-op that makes no RPC call and logs once", async () => {
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  let fetches = 0;
  const lines: string[] = [];
  globalThis.fetch = (async () => { fetches++; throw new Error("no network expected"); }) as unknown as typeof fetch;
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  try {
    resetFlowIdleLog();
    await withEnv({ FLOW_QUEUE_ADDRESS: undefined, FLOW_FUND_ADDRESS: undefined }, async () => {
      expect(await refreshFlowIndex()).toMatchObject({ idle: true });
      expect(await refreshFlowIndex()).toMatchObject({ idle: true });
    });
    await withEnv({ FLOW_QUEUE_ADDRESS: "", FLOW_FUND_ADDRESS: "" }, async () => { expect(await refreshFlowIndex()).toMatchObject({ idle: true }); });
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
  }
  expect(fetches).toBe(0);
  expect(lines.filter((l) => l.includes("[flow.index] idle")).length).toBe(1);
});

test("a half-configured worker still rejects loudly", async () => {
  await withEnv({ FLOW_QUEUE_ADDRESS: "0x" + "1".repeat(40), FLOW_FUND_ADDRESS: undefined }, async () => {
    await expect(refreshFlowIndex()).rejects.toThrow("FLOW_QUEUE_ADDRESS, FLOW_FUND_ADDRESS");
  });
});
