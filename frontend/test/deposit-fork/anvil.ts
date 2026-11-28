// An anvil fork of Base for the deposit fork spec (issue 1778).
//
// Pinned to FORK_BLOCK so every run sees the same vault: Deploy 4 on contracts
// 0.10.0, with a per-deposit cap of 100 USDC. Anvil's dev account 0 already
// holds 10000 ETH on the fork; it gets 1000 USDC by a write to USDC's balance
// slot (FiatToken keeps balances in the mapping at slot 9), not by taking it
// from a holder, whose balance at the block is someone else's to change.
//
// No anvil, or a fork RPC that does not answer, fails the spec loudly: there is
// no skip. CI installs foundry and caches the fork's RPC reads by block.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createPublicClient, encodeAbiParameters, http, keccak256, pad, toHex, type Address, type Hex } from "viem";
import { base } from "viem/chains";

export const FORK_URL = "https://mainnet.base.org";
export const FORK_BLOCK = 63_480_000;
/** Anvil's dev account 0 and its well-known key. */
export const DEV0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
export const DEV0_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
/** FiatToken's `balanceAndBlacklistStates` mapping. */
const USDC_BALANCE_SLOT = 9n;
export const FUNDED_USDC = 1_000_000_000n;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? resolve(a.port) : reject(new Error("no free port"))));
    });
  });
}

export type Fork = Awaited<ReturnType<typeof startFork>>;

/** Start anvil at FORK_BLOCK on a free port and wait for it to answer. */
export async function startFork() {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const args = ["--fork-url", FORK_URL, "--fork-block-number", String(FORK_BLOCK), "--chain-id", "8453", "--port", String(port), "--host", "127.0.0.1"];
  const proc: ChildProcess = spawn("anvil", args, { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout?.on("data", (d) => (log += d));
  proc.stderr?.on("data", (d) => (log += d));
  const failed = new Promise<never>((_, reject) => {
    proc.once("error", (e) => reject(new Error(`anvil did not start (${e.message}). Install foundry: https://getfoundry.sh`)));
    proc.once("exit", (code) => reject(new Error(`anvil exited (${code}) before answering:\n${log}`)));
  });
  const client = createPublicClient({ chain: base, transport: http(url) });
  const answered = (async () => {
    const until = Date.now() + 90_000;
    for (;;) {
      try { return await client.getChainId(); } catch {
        if (Date.now() > until) throw new Error(`anvil did not answer on ${url} in 90 s:\n${log}`);
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  })();
  const chainId = await Promise.race([answered, failed]);
  if (chainId !== 8453) throw new Error(`the fork answers chain ${chainId}, not Base (8453)`);
  // Unhandled once started: a later exit shows as failed reads.
  failed.catch(() => {});

  const rpc = (method: string, params: unknown[] = []) => client.request({ method: method as never, params: params as never });
  return {
    url,
    client,
    rpc,
    /** Give `owner` exactly `amount` USDC units by writing its balance slot. */
    async setUsdc(usdc: Address, owner: Address, amount: bigint) {
      const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, USDC_BALANCE_SLOT]));
      await rpc("anvil_setStorageAt", [usdc, slot, pad(toHex(amount), { size: 32 })]);
    },
    snapshot: () => rpc("evm_snapshot") as Promise<Hex>,
    revert: (id: Hex) => rpc("evm_revert", [id]),
    /** Stop anvil. SIGINT lets it write its RPC cache (~/.foundry/cache/rpc/base) for the next run. */
    async stop() {
      if (proc.exitCode !== null) return;
      const exited = new Promise((r) => proc.once("exit", r));
      proc.kill("SIGINT");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      if (proc.exitCode === null) proc.kill("SIGKILL");
    },
  };
}
