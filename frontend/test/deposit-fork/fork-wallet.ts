// The test wallet for the deposit fork spec (issue 1778): a browser extension
// as far as the page can tell, signing for real in Node.
//
// In the page, an init script defines an EIP-1193 provider and announces it
// over EIP-6963 as "RM Fork Test Wallet", so the page's AppKit modal lists it
// next to any installed wallet. Every request() crosses into Node through
// page.exposeBinding. There, dev account 0 is the only account, the chain is
// Base (0x2105), wallet_getCapabilities is refused (4200) so the page takes
// its one-call-after-another path, and eth_sendTransaction is signed by a viem
// local account and sent as a raw transaction to the fork. Like an extension,
// it shows the site no account (eth_accounts is empty) until the site asks
// with eth_requestAccounts, so only the modal connects it. Everything else is
// passed to anvil as is. Each eth_sendTransaction is recorded for the spec.
import type { Page } from "@playwright/test";
import { createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { DEV0, DEV0_KEY, type Fork } from "./anvil.ts";

export const WALLET_NAME = "RM Fork Test Wallet";
const RDNS = "network.robotmoney.forktest";
const BINDING = "__rmForkWallet";

type Sent = { to: Address; data: Hex; hash: Hex };
type Answer = { result: unknown } | { error: { code: number; message: string; data?: unknown } };

/** Runs in the page before any of its scripts: the provider and its EIP-6963 announcement. */
function inject({ binding, name, rdns }: { binding: string; name: string; rdns: string }) {
  const call = (window as unknown as Record<string, (m: string, p: unknown) => Promise<Answer>>)[binding];
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const provider = {
    async request({ method, params }: { method: string; params?: unknown }) {
      const a = await call(method, params ?? []);
      if ("error" in a) throw Object.assign(new Error(a.error.message), a.error);
      return a.result;
    },
    on(ev: string, fn: (...a: unknown[]) => void) { if (!listeners.has(ev)) listeners.set(ev, new Set()); listeners.get(ev)!.add(fn); return provider; },
    removeListener(ev: string, fn: (...a: unknown[]) => void) { listeners.get(ev)?.delete(fn); return provider; },
  };
  const icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 8 8'%3E%3Crect width='8' height='8' fill='%2306b6d4'/%3E%3C/svg%3E";
  const detail = Object.freeze({ info: Object.freeze({ uuid: "6a1ef0e4-5b3c-4b6e-9a51-1778f0c0ffee", name, icon, rdns }), provider });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}

/** Install the test wallet on `page`, signing as dev account 0 on `fork`. */
export async function installForkWallet(page: Page, fork: Fork) {
  const sent: Sent[] = [];
  const methods: string[] = [];
  let connected = false;
  const account = privateKeyToAccount(DEV0_KEY);
  const signer = createWalletClient({ account, chain: base, transport: http(fork.url) });

  async function answer(method: string, params: unknown[]): Promise<Answer> {
    methods.push(method);
    switch (method) {
      // As an extension does: no account for the site until it asks and the user says yes.
      case "eth_requestAccounts":
        connected = true;
        return { result: [DEV0] };
      case "eth_accounts":
        return { result: connected ? [DEV0] : [] };
      case "eth_chainId":
        return { result: "0x2105" };
      case "net_version":
        return { result: "8453" };
      case "wallet_switchEthereumChain": {
        const id = (params[0] as { chainId?: string })?.chainId;
        return id?.toLowerCase() === "0x2105" ? { result: null } : { error: { code: 4902, message: `Unrecognized chain ${id}` } };
      }
      case "wallet_getCapabilities":
        return { error: { code: 4200, message: "wallet_getCapabilities is not supported" } };
      case "eth_sendTransaction": {
        const tx = params[0] as { from?: string; to: Address; data?: Hex; value?: Hex; gas?: Hex };
        if (tx.from && tx.from.toLowerCase() !== DEV0.toLowerCase()) return { error: { code: 4100, message: `Unknown account ${tx.from}` } };
        const hash = await signer.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
          gas: tx.gas ? BigInt(tx.gas) : undefined,
        });
        sent.push({ to: tx.to, data: tx.data ?? "0x", hash });
        return { result: hash };
      }
      default: {
        const res = await fetch(fork.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
        return body.error ? { error: body.error } : { result: body.result ?? null };
      }
    }
  }

  await page.exposeBinding(BINDING, async (_source, method: string, params: unknown[]) => {
    try { return await answer(method, params); }
    catch (e) { return { error: { code: -32603, message: e instanceof Error ? e.message : String(e) } }; }
  });
  await page.addInitScript(inject, { binding: BINDING, name: WALLET_NAME, rdns: RDNS });
  return { sent, methods };
}
