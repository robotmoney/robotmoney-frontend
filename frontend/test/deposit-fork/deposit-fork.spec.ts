// A real wallet deposit on an anvil fork of Base (issue 1778).
//
// deposit-wallet.spec.ts proves the production CSP lets the wallet kit open;
// nothing there is signed. Here a test wallet (fork-wallet.ts) connects
// through the page's own AppKit modal and signs the page's deposit for real,
// on a fork of Base at FORK_BLOCK (anvil.ts), and the spec reads the result
// back from the fork.
//
// The page is served the way deposit-wallet.spec.ts serves it, on the origin
// http://localhost: the shell carries WEBSITE_CSP unchanged, same-origin files
// come from frontend/public, Reown's hosts answer with mocks and every other
// origin is aborted. It opens at /deposit?rpc=http://localhost/, so the node
// the page reads and sends through (manifest.js `rpc`, local hosts only) is
// same-origin and `connect-src 'self'` covers it; the route forwards those
// JSON-RPC POSTs to anvil. The early access gate is the real one, opened by
// RM-LOCAL-TESTS, which works on a local host only.
//
// Run with `bun run test:deposit-fork` (playwright.fork.config.ts). It needs
// anvil on PATH and fails without it.
import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { createWalletClient, decodeFunctionData, getAddress, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { WEBSITE_CSP } from "../../../scripts/lib/website-image.ts";
import { MANIFEST } from "../../public/assets/js/app/lib/deposit/manifest.js";
import { QUEUE_ABI, ERC20_ABI, REQUEST_TOPICS } from "../../public/assets/js/app/lib/deposit/abi.js";
import { createChainSource } from "../../public/assets/js/app/lib/deposit/chain.js";
import { startFork, DEV0, DEV0_KEY, FUNDED_USDC, FORK_BLOCK, type Fork } from "./anvil.ts";
import { installForkWallet, WALLET_NAME } from "./fork-wallet.ts";

const ROOT = process.cwd();
const PUB = join(ROOT, "frontend/public");
const ORIGIN = "http://localhost";
const shell = readFileSync(join(PUB, "index.html"), "utf8");
const goldens = JSON.parse(readFileSync(join(ROOT, "goldens/api-goldens.json"), "utf8")).routes;
const VENDORS: Record<string, string> = {
  "/assets/js/vendor/alpinejs-3.14.9.min.js": "node_modules/alpinejs/dist/cdn.min.js",
  "/assets/js/vendor/chart-4.5.1.umd.min.js": "node_modules/chart.js/dist/chart.umd.min.js",
  "/assets/js/vendor/p5-1.11.2.min.js": "node_modules/p5/lib/p5.min.js",
};
/** Hosts the CSP approves for the kit other than Base's, answered here with mocks. */
const REOWN_HTTP = /^https:\/\/(rpc\.walletconnect\.(org|com)|api\.web3modal\.(org|com)|fonts\.reown\.com)$/;
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };

const USDC = MANIFEST.usdc as Address;
const QUEUE = MANIFEST.queue as Address;
const FUND = MANIFEST.fund as Address;
const DEPOSIT_TOPIC = REQUEST_TOPICS[0];
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** Reown's RPC, if the kit asks it anything: "nothing there". */
function rpcAnswer(body: string | null): unknown {
  let req: unknown;
  try { req = JSON.parse(body || "null"); } catch { req = null; }
  const one = (r: { id?: number; method?: string }) => ({ jsonrpc: "2.0", id: r?.id ?? 1, result: r?.method === "eth_chainId" ? "0x2105" : "0x" });
  return Array.isArray(req) ? req.map(one) : one((req ?? {}) as { id?: number; method?: string });
}

let fork: Fork;

const usdcOf = (a: Address) => fork.client.readContract({ address: USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [a] }) as Promise<bigint>;
const allowanceOf = (a: Address) => fork.client.readContract({ address: USDC, abi: ERC20_ABI, functionName: "allowance", args: [a, QUEUE] }) as Promise<bigint>;
const queueRead = <T>(functionName: string, args: unknown[] = []) => fork.client.readContract({ address: QUEUE, abi: QUEUE_ABI, functionName, args } as never) as Promise<T>;
const implOf = async (a: Address) => `0x${((await fork.client.getStorageAt({ address: a, slot: IMPL_SLOT })) ?? "0x").slice(-40)}`.toLowerCase();

test.beforeAll(async () => {
  fork = await startFork();
  await fork.setUsdc(USDC, DEV0, FUNDED_USDC);
  // The fork is what the page will see: dev 0 funded and unapproved, and the
  // vault on the implementations the page is pinned to, or it refuses to send.
  expect(await usdcOf(DEV0)).toBe(FUNDED_USDC);
  expect(await allowanceOf(DEV0)).toBe(0n);
  const pins = MANIFEST.pins!;
  expect(pins.fund.map((p) => p.toLowerCase()), `the fund's implementation at block ${FORK_BLOCK} is not in MANIFEST.pins: bump FORK_BLOCK to a block on the pinned release`).toContain(await implOf(FUND));
  expect(pins.queue.map((p) => p.toLowerCase()), `the queue's implementation at block ${FORK_BLOCK} is not in MANIFEST.pins: bump FORK_BLOCK to a block on the pinned release`).toContain(await implOf(QUEUE));

  // Warm the fork. A cold fork fetches each storage slot from Base's public
  // RPC, which throttles, and the page's reads time out after 10 s and fall
  // back to Reown's RPC (mocked here, so they fail). So the spec first reads
  // what the page reads, through the page's own chain.js, and makes the same
  // deposit once and reverts it. Anvil keeps what it fetched across a revert,
  // and in ~/.foundry/cache/rpc for the next run.
  test.setTimeout(600_000);
  const src = createChainSource({
    // chain.js builds its calls as plain objects, untyped.
    read: (c: any) => fork.client.readContract(c),
    readMany: (cs: any[]) => fork.client.multicall({ contracts: cs, allowFailure: false }),
  });
  await src.vault();
  await src.account(DEV0);
  await src.requestsOf(DEV0);
  await src.quoteDeposit(10);
  const warm = await fork.snapshot();
  const signer = createWalletClient({ account: privateKeyToAccount(DEV0_KEY), chain: base, transport: http(fork.url) });
  for (const hash of [
    await signer.writeContract({ address: USDC, abi: ERC20_ABI, functionName: "approve", args: [QUEUE, 10_000_000n] }),
    await signer.writeContract({ address: QUEUE, abi: QUEUE_ABI, functionName: "requestDeposit", args: [10_000_000n, DEV0] }),
  ]) expect((await fork.client.waitForTransactionReceipt({ hash })).status).toBe("success");
  await fork.revert(warm);
});
test.afterAll(async () => { await fork?.stop(); });

// Each test starts from the funded fork.
let snap: `0x${string}`;
test.beforeEach(async () => { snap = await fork.snapshot(); });
test.afterEach(async () => { await fork.revert(snap); });

async function serve(page: Page) {
  const forwarded: string[] = [];
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(`${e.effectiveDirective} ${e.blockedURI}`);
    });
  });
  await page.routeWebSocket(/^wss:\/\/relay\.walletconnect\.(org|com)\//, () => {});
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== ORIGIN) {
      if (!REOWN_HTTP.test(url.origin)) return route.abort();
      if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      if (url.host.startsWith("fonts.")) return route.fulfill({ status: 404, headers: cors, body: "" });
      if (url.host.startsWith("api.web3modal.")) return route.fulfill({ headers: cors, json: { data: [], count: 0 } });
      return route.fulfill({ headers: cors, json: rpcAnswer(request.postData()) });
    }
    // The page's node (?rpc=http://localhost/): same-origin, forwarded to the fork.
    if (request.method() === "POST" && url.pathname === "/") {
      forwarded.push(request.postData() ?? "");
      const response = await route.fetch({ url: fork.url });
      return route.fulfill({ response });
    }
    if (url.pathname === "/api/version") return route.fulfill({ json: { version: "0.5.0" } });
    if (url.pathname === "/version.json") return route.fulfill({ json: { version: "0.1.0", apiRange: "^0.5.0" } });
    if (url.pathname.startsWith("/api/")) return route.fulfill({ json: goldens[url.pathname] ?? {} });
    if (request.isNavigationRequest()) {
      return route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": WEBSITE_CSP }, body: shell });
    }
    const file = VENDORS[url.pathname] ? join(ROOT, VENDORS[url.pathname]) : join(PUB, url.pathname);
    if (existsSync(file)) return route.fulfill({ path: file, contentType: extname(file) === ".js" ? "text/javascript" : undefined });
    return route.fulfill({ status: 404, body: "not found" });
  });
  const wallet = await installForkWallet(page, fork);
  return { forwarded, wallet };
}

/**
 * What the policy refused. AppKit beacons INITIALIZE and CONNECT_SUCCESS to
 * pulse.walletconnect.org whatever `features.analytics` says, and D97 does not
 * approve that host, so the policy refuses it on the deployed site too. That
 * one refusal is expected; any other is a failure.
 */
const PULSE = /^connect-src https:\/\/pulse\.walletconnect\.org\//;
const violations = async (page: Page) => (await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).filter((v) => !PULSE.test(v));

/** Open /deposit on the fork, pass the gate, and connect the test wallet through the page's modal. */
async function openAndConnect(page: Page) {
  await page.goto(`${ORIGIN}/deposit?rpc=${ORIGIN}/`);
  await page.locator("#dp-code").fill("RM-LOCAL-TESTS");
  await expect(page.locator(".dp__title")).toContainText("Robot Money Vault");
  await page.locator(".dp__panel .btn-primary:visible", { hasText: "Connect wallet" }).click();
  await expect(page.locator("w3m-modal")).toBeAttached({ timeout: 30_000 });
  await page.getByText(WALLET_NAME, { exact: true }).first().click({ timeout: 30_000 });
  // Connected: the panel's Connect wallet gives way to the deposit review.
  await expect(page.locator(".dp__panel .btn-primary:visible", { hasText: "Review deposit" })).toBeVisible({ timeout: 30_000 });
}

test("a wallet connected through the modal requests a deposit on the fork", async ({ page }) => {
  const { forwarded, wallet } = await serve(page);
  const countBefore = await queueRead<bigint>("requestCount");
  const pendingBefore = (await queueRead<{ pendingUsdc: bigint }>("books")).pendingUsdc;

  await openAndConnect(page);
  await page.locator("#dp-amt").fill("10");
  const review = page.locator(".dp__panel .btn-primary:visible", { hasText: "Review deposit" });
  await expect(review).toBeEnabled({ timeout: 30_000 });
  await review.click();
  await page.locator(".dp__ack input[type=checkbox]").check();
  const confirm = page.getByRole("button", { name: "Confirm in wallet" });
  await expect(confirm).toBeEnabled({ timeout: 30_000 });
  await confirm.click();
  const link = page.locator(".dp__follow a.dp__ext");
  await expect(link).toHaveAttribute("href", /^\/deposit\/requests\/\d+$/, { timeout: 60_000 });

  // The wallet signed exactly the two calls the page built: an exact approve, then the request.
  expect(wallet.sent.map((s) => getAddress(s.to))).toEqual([getAddress(USDC), getAddress(QUEUE)]);
  const approve = decodeFunctionData({ abi: ERC20_ABI, data: wallet.sent[0].data });
  expect(approve.functionName).toBe("approve");
  expect(getAddress(approve.args![0] as Address)).toBe(getAddress(QUEUE));
  expect(approve.args![1]).toBe(10_000_000n);
  const request = decodeFunctionData({ abi: QUEUE_ABI, data: wallet.sent[1].data });
  expect(request.functionName).toBe("requestDeposit");
  expect(request.args![0]).toBe(10_000_000n);
  expect(getAddress(request.args![1] as Address)).toBe(DEV0);

  // The fork holds the request.
  const countAfter = await queueRead<bigint>("requestCount");
  expect(countAfter).toBe(countBefore + 1n);
  const receipt = await fork.client.getTransactionReceipt({ hash: wallet.sent[1].hash });
  const log = receipt.logs.find((l) => l.address.toLowerCase() === QUEUE.toLowerCase() && l.topics[0]?.toLowerCase() === DEPOSIT_TOPIC);
  expect(log, "the request's DepositRequested log").toBeTruthy();
  const id = BigInt(log!.topics[1]!);
  expect(id).toBe(countAfter);
  const req = await queueRead<{ owner: Address; amount: bigint; closed: boolean }>("getRequest", [id]);
  expect(getAddress(req.owner)).toBe(DEV0);
  expect(req.amount).toBe(10_000_000n);
  expect(req.closed).toBe(false);
  expect(await queueRead<number>("requestStatus", [id])).toBe(1); // Pending
  expect(await queueRead<bigint>("pendingDepositRequest", [id, DEV0])).toBe(10_000_000n);
  expect(await usdcOf(DEV0)).toBe(990_000_000n);
  expect(await allowanceOf(DEV0)).toBe(0n);
  expect((await queueRead<{ pendingUsdc: bigint }>("books")).pendingUsdc).toBe(pendingBefore + 10_000_000n);

  // The page names the same request.
  await expect(link).toHaveAttribute("href", `/deposit/requests/${id}`);
  // Its reads and sends went through the same-origin node, and the policy refused nothing.
  expect(forwarded.length).toBeGreaterThan(0);
  expect(await violations(page)).toEqual([]);
});

test("a request over the vault's per-deposit cap is refused before the wallet opens", async ({ page }) => {
  const { wallet } = await serve(page);
  const countBefore = await queueRead<bigint>("requestCount");

  await openAndConnect(page);
  // The cap at FORK_BLOCK is 100 USDC (fund config perDepositCap).
  await page.locator("#dp-amt").fill("101");
  await expect(page.locator("#dp-amt-msg")).toContainText("The largest request is", { timeout: 30_000 });
  await expect(page.locator(".dp__panel .btn-primary:visible", { hasText: "Review deposit" })).toBeDisabled();

  expect(wallet.sent).toHaveLength(0);
  expect(wallet.methods).not.toContain("eth_sendTransaction");
  expect(await queueRead<bigint>("requestCount")).toBe(countBefore);
  expect(await violations(page)).toEqual([]);
});
