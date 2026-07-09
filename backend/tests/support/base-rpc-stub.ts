// Deterministic, request-counting Base JSON-RPC stub for the HERMETIC e2e demo
// (issue #48). Stands in for live Base mainnet (https://mainnet.base.org) so the
// required `e2e` check never reaches an uncontrolled, rate-limited network host.
//
// It answers ONLY the `eth_call` reads that chain/vault-economics.ts readLive()
// makes — ERC-4626 totalAssets(), ERC-20 totalSupply(), ERC-20 balanceOf(addr) —
// with fixed fixture words, and it RECORDS how many eth_call requests it served.
// The demo's post-run guard (scripts/demo-rpc-guard.ts) reads that count over
// GET /__count: a positive count proves the /allocation vault-economics path
// routed to THIS stub, which — because the stub is the only RPC the demo stack
// is configured to reach — is the proof that live Base mainnet received ZERO
// eth_call requests.
//
// The returned magnitudes mirror the offline mocked suite
// (backend/tests/vault-economics.test.ts) so the values the browser renders are
// recognizable ($84,320.12 TVL) and deterministic. This file is NOT a test
// (no .test.ts suffix) and never runs under `bun test`; it is launched as a
// container service by docker-compose.demo.yml.
const PORT = Number(process.env.STUB_PORT ?? 8645);

// eth_call selectors (first 4 bytes of keccak256(signature)); see base-rpc-client.ts.
const TOTAL_ASSETS = "0x01e1d114"; // totalAssets()
const TOTAL_SUPPLY = "0x18160ddd"; // totalSupply()
const BALANCE_OF = "0x70a08231"; // balanceOf(address)
const CONVERT_TO_ASSETS = "0x07a2d13a"; // convertToAssets(uint256) — ERC-4626 strategy NAV (issue #84)

// config.ts default vault address (the demo runs with no VAULT_ADDRESS override).
// Adapter reads (any other `to`) return a distinct per-adapter balance.
const VAULT = "0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd";

const word = (n: bigint): string => "0x" + n.toString(16).padStart(64, "0");

let ethCallCount = 0;
const seen = new Set<string>(); // distinct `to:selector` pairs, for the guard's log

function resultFor(to: string, data: string): string {
  const selector = data.slice(0, 10);
  const toLc = to.toLowerCase();
  if (selector === TOTAL_SUPPLY) return word(84_102_550_000n); // 84,102.55 vault shares
  if (selector === BALANCE_OF) return word(1_000_000n); // $1.00 idle USDC / 1 unit prop-wallet balance (issue #84)
  if (selector === CONVERT_TO_ASSETS) return word(4_500_000_000n); // 4,500 USDC strategy NAV (issue #84)
  if (selector === TOTAL_ASSETS) {
    // Vault TVL vs. each adapter's holdings (mirrors the mocked-suite fixtures).
    return toLc === VAULT ? word(84_320_120_000n) : word(28_000_000_000n);
  }
  return word(0n);
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/__count") {
      return Response.json({ ethCall: ethCallCount, seen: [...seen] });
    }
    if (req.method !== "POST") return new Response("base-rpc-stub", { status: 200 });
    const body = (await req.json().catch(() => null)) as
      | { id?: number; method?: string; params?: any[] }
      | null;
    // Native ETH balance for the prop-wallet valuation feed (issue #84): a fixed
    // 0.05 ETH per wallet. Counted like eth_call so the demo RPC guard still
    // proves the wallet path routed to THIS stub, not live mainnet.
    if (body?.method === "eth_getBalance") {
      ethCallCount += 1;
      seen.add(`${String(body.params?.[0]).toLowerCase()}:eth_getBalance`);
      return Response.json({ jsonrpc: "2.0", id: body.id ?? 1, result: word(50_000_000_000_000_000n) });
    }
    if (!body || body.method !== "eth_call" || !body.params?.[0]) {
      return Response.json({
        jsonrpc: "2.0",
        id: body?.id ?? 1,
        error: { code: -32601, message: "base-rpc-stub: eth_call / eth_getBalance only" },
      });
    }
    ethCallCount += 1;
    const { to, data } = body.params[0] as { to: string; data: string };
    seen.add(`${to.toLowerCase()}:${data.slice(0, 10)}`);
    return Response.json({ jsonrpc: "2.0", id: body.id ?? 1, result: resultFor(to, data) });
  },
});

// eslint-disable-next-line no-console
console.log(`[base-rpc-stub] listening on :${PORT} — deterministic vault-economics fixtures, request-counting (zero live mainnet)`);
