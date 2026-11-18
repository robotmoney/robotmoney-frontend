// Issue 1664: the production preflight reads CoinGecko's GET /key once and goes red when the paid account's remaining
// monthly credit is below the floor. The fetch is injected; no network. The key never reaches stdout or stderr.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCoingeckoCredit, floorPctFromEnv, KEY_URL, resolveKey } from "../../release/coingecko-credit.ts";

const KEY = "CG-credit-test-key-never-printed";

function usage(remaining: number, monthly = 500_000) {
  return { plan: "Basic", rate_limit_request_per_minute: 250, monthly_call_credit: monthly, current_total_monthly_calls: monthly - remaining, current_remaining_monthly_calls: remaining };
}

async function run(body: unknown, opts: { status?: number; key?: string | undefined; floorPct?: number } = {}) {
  const lines: { out: string[]; err: string[]; sent: { url: string; key: string | null }[] } = { out: [], err: [], sent: [] };
  const code = await checkCoingeckoCredit({
    key: "key" in opts ? opts.key : KEY,
    floorPct: opts.floorPct ?? 10,
    fetch: async (url, init) => {
      lines.sent.push({ url, key: new Headers(init.headers).get("x-cg-pro-api-key") });
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status: opts.status ?? 200 });
    },
    out: (l) => lines.out.push(l),
    err: (l) => lines.err.push(l),
  });
  return { code, ...lines, all: [...lines.out, ...lines.err].join("\n") };
}

describe("coingecko-credit", () => {
  test("remaining credit below the floor exits non-zero", async () => {
    const r = await run(usage(49_999));
    expect(r.code).not.toBe(0);
    expect(r.all).toContain("below the floor 50000");
    expect(r.all).not.toContain(KEY);
  });

  test("remaining credit above the floor exits 0 and prints used, remaining and monthly credit", async () => {
    const r = await run(usage(300_000));
    expect(r.code).toBe(0);
    expect(r.out.join("\n")).toContain("used 200000, remaining 300000, monthly credit 500000");
    expect(r.sent).toEqual([{ url: KEY_URL, key: KEY }]);
    expect(r.all).not.toContain(KEY);
  });

  test("a missing or blank key exits non-zero without calling CoinGecko", async () => {
    for (const key of [undefined, "", "   "]) {
      const r = await run(usage(300_000), { key });
      expect(r.code).not.toBe(0);
      expect(r.sent).toEqual([]);
      expect(r.err.join("\n")).toContain("no COINGECKO_API_KEY");
    }
  });

  test("an HTTP error or an unreadable body exits non-zero, and an echoed key is redacted", async () => {
    const refused = await run({ status: { error_code: 10002, error_message: `bad key ${KEY}` } }, { status: 401 });
    expect(refused.code).toBe(1);
    expect(refused.all).toContain("HTTP 401");
    expect(refused.all).not.toContain(KEY);
    expect((await run("not json")).code).toBe(1);
    expect((await run({ plan: "Basic" })).code).toBe(1);
  });

  test("the floor comes from COINGECKO_CREDIT_FLOOR_PCT, default 10", () => {
    expect(floorPctFromEnv(undefined)).toBe(10);
    expect(floorPctFromEnv("")).toBe(10);
    expect(floorPctFromEnv("25")).toBe(25);
    expect(floorPctFromEnv("-1")).toBe(10);
    expect(floorPctFromEnv("abc")).toBe(10);
  });

  test("the key comes from the environment, else from the env file", () => {
    const dir = mkdtempSync(join(tmpdir(), "rm-coingecko-credit-"));
    try {
      const file = join(dir, ".env");
      writeFileSync(file, `# research\nCOINGECKO_API_KEY=${KEY}\n`);
      expect(resolveKey(file, {})).toBe(KEY);
      expect(resolveKey(file, { COINGECKO_API_KEY: "from-env" })).toBe("from-env");
      expect(resolveKey(join(dir, "absent"), {})).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
