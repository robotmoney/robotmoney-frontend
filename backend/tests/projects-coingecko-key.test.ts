// THE PAID COINGECKO KEY REACHES COINGECKO (issue #1047).
//
// The projects live source used to send COINGECKO_API_KEY to the PUBLIC host
// as `x-cg-smoke-api-key` (a corruption of `x-cg-demo-api-key` from the
// demo-to-smoke rename), so CoinGecko ignored it and the paid plan never
// applied. The contract pinned here:
//   - key unset or blank → exactly one GET to the public host, no x-cg-* header;
//   - key set → the Pro host with x-cg-pro-api-key, and no legacy header;
//   - a 401/429 from either host rejects with an Error naming host and status,
//     never the key, and the tier log line never carries the key either.
//
// fetch is stubbed ONLY at the process boundary (globalThis.fetch); the real
// live source runs. Fully offline; gates every PR in the backend job.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { liveProjectsDataSource } from "../src/projects/access/live-source.ts";

const KEY = "cg-test-key-9f3a7e1c-never-log-me";
const PUBLIC_MARKETS = "https://api.coingecko.com/api/v3/coins/markets";
const PRO_MARKETS = "https://pro-api.coingecko.com/api/v3/coins/markets";

const realFetch = globalThis.fetch;
const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;
const prevKey = process.env.COINGECKO_API_KEY;

interface Call {
  url: string;
  method: string;
  headers: Headers;
}

let calls: Call[] = [];
let logged: string[] = [];

function stubFetch(status: number, body: unknown = []): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, method: (init?.method ?? "GET").toUpperCase(), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function xcgHeaders(h: Headers): string[] {
  return [...h.keys()].filter((k) => k.toLowerCase().startsWith("x-cg-"));
}

beforeEach(() => {
  calls = [];
  logged = [];
  const capture = (...args: unknown[]) => {
    logged.push(args.map((a) => (a instanceof Error ? `${a.message}\n${a.stack ?? ""}` : String(a))).join(" "));
  };
  console.log = capture;
  console.warn = capture;
  console.error = capture;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
  if (prevKey === undefined) delete process.env.COINGECKO_API_KEY;
  else process.env.COINGECKO_API_KEY = prevKey;
});

describe("coinGeckoMarkets host and header selection", () => {
  for (const [label, value] of [["unset", undefined], ["blank", ""], ["whitespace", "   "]] as const) {
    test(`key ${label} → one keyless GET to the public host`, async () => {
      if (value === undefined) delete process.env.COINGECKO_API_KEY;
      else process.env.COINGECKO_API_KEY = value;
      stubFetch(200, [{ id: "virtual-protocol" }]);

      const rows = await liveProjectsDataSource.coinGeckoMarkets(["virtual-protocol"]);

      expect(rows).toEqual([{ id: "virtual-protocol" }] as never);
      expect(calls.length).toBe(1);
      expect(calls[0]!.method).toBe("GET");
      expect(calls[0]!.url.startsWith(`${PUBLIC_MARKETS}?`)).toBe(true);
      expect(xcgHeaders(calls[0]!.headers)).toEqual([]);
      expect(logged.join("\n")).toContain("public tier (api.coingecko.com)");
    });
  }

  test("key set → GET to the Pro host with x-cg-pro-api-key and no legacy header", async () => {
    process.env.COINGECKO_API_KEY = KEY;
    stubFetch(200, []);

    await liveProjectsDataSource.coinGeckoMarkets(["virtual-protocol", "aixbt"]);

    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url.startsWith(`${PRO_MARKETS}?`)).toBe(true);
    expect(call.url).toContain("ids=virtual-protocol,aixbt");
    expect(call.url).not.toContain(KEY);
    expect(call.headers.get("x-cg-pro-api-key")).toBe(KEY);
    expect(call.headers.has("x-cg-smoke-api-key")).toBe(false);
    expect(call.headers.has("x-cg-demo-api-key")).toBe(false);
    expect(xcgHeaders(call.headers)).toEqual(["x-cg-pro-api-key"]);

    const out = logged.join("\n");
    expect(out).toContain("pro tier (pro-api.coingecko.com)");
    expect(out).not.toContain(KEY);
  });
});

describe("a failed CoinGecko call never carries the key", () => {
  const cases = [
    { tier: "pro", key: KEY, host: "pro-api.coingecko.com" },
    { tier: "public", key: undefined, host: "api.coingecko.com" },
  ] as const;

  for (const { tier, key, host } of cases) {
    for (const status of [401, 429]) {
      test(`${tier} host ${status} → Error names host and status, never the key`, async () => {
        if (key === undefined) delete process.env.COINGECKO_API_KEY;
        else process.env.COINGECKO_API_KEY = key;
        stubFetch(status, { status: { error_code: status, error_message: "stubbed" } });

        let caught: unknown;
        try {
          await liveProjectsDataSource.coinGeckoMarkets(["virtual-protocol"]);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(Error);
        const message = (caught as Error).message;
        expect(message).toContain(host);
        expect(message).toContain(String(status));
        expect(message).not.toContain(KEY);
        expect(String((caught as Error).stack ?? "")).not.toContain(KEY);

        const out = logged.join("\n");
        expect(out).toContain(`${tier} tier (${host})`);
        expect(out).not.toContain(KEY);
      });
    }
  }
});

describe("a malformed key is refused before it can reach a header error", () => {
  // Bun's fetch rejects a header value with a control character and echoes the
  // value in its error text. The live source must refuse such a key first, so
  // the degraded run's log and job_runs row never carry it.
  for (const [label, bad] of [["LF", `${KEY}\nX`], ["CR", `${KEY}\rX`], ["NUL", `${KEY}\u0000X`], ["space", `${KEY} X`]] as const) {
    test(`an inner ${label} → rejects without calling CoinGecko and without the key in the error`, async () => {
      process.env.COINGECKO_API_KEY = bad;
      stubFetch(200, []);

      let caught: unknown;
      try {
        await liveProjectsDataSource.coinGeckoMarkets(["virtual-protocol"]);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      expect(calls.length).toBe(0);
      const message = (caught as Error).message;
      expect(message).toContain("COINGECKO_API_KEY");
      expect(message).toContain("pro-api.coingecko.com");
      expect(message).not.toContain(KEY);
      expect(String((caught as Error).stack ?? "")).not.toContain(KEY);
      expect(logged.join("\n")).not.toContain(KEY);
    });
  }
});
