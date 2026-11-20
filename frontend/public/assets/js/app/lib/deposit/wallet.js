// @ts-nocheck: the wallet layer for /deposit (RM-146, RM-207). The only file
// that touches the wallet kit: Reown AppKit in plain JavaScript with the wagmi
// adapter, vendored as one file (assets/js/vendor/rm-appkit-1.8.24.min.js) and
// imported on first use, so no other page downloads it.
//
// Bring your own wallet: AppKit lists browser extensions (EIP-6963), mobile
// wallets and Safe over WalletConnect, and Coinbase Smart Wallet. We never see
// a key and never create a wallet. Email and social login, onramp and swaps
// are off here and in the Reown dashboard (project "RM Vaults").
//
// The design review (canvas board 21) drives the send path:
// - every call is simulated first, so the wallet never opens on a call that
//   would fail (`simulate`);
// - where the wallet supports atomic batches (EIP-5792: Coinbase Smart Wallet,
//   Safe, newer MetaMask), approve and request go as one confirmation
//   (`canBatch`, `sendBatch`); elsewhere they go one after the other;
// - wallet errors are turned into sentences (`errorText`).
//
// The project id is public by design: it ships in every page that uses it, and
// the dashboard's domain allowlist is what keeps other sites from using it.

import { MANIFEST } from "./manifest.js";

export const REOWN_PROJECT_ID = "47925b0f4aa68c28fb5b0760e9dd0a36";

let loading = null;

/** Load the kit once and open a session. Resolves to the handle the page uses. */
export function loadWallet() {
  // A literal specifier: the asset stamper (scripts/lib/stamp-assets.ts) refuses a
  // computed import(), and vendor files are versioned by name, so this stays as is.
  if (!loading) loading = import("/assets/js/vendor/rm-appkit-1.8.24.min.js").then(boot);
  return loading;
}

function boot(kit) {
  const networks = [kit.base];
  const adapter = new kit.WagmiAdapter({ networks, projectId: REOWN_PROJECT_ID });
  const config = adapter.wagmiConfig;
  const modal = kit.createAppKit({
    adapters: [adapter],
    networks,
    defaultNetwork: kit.base,
    projectId: REOWN_PROJECT_ID,
    metadata: {
      name: "Robot Money",
      description: "Deposit into the Robot Money model portfolio",
      url: location.origin,
      icons: [`${location.origin}/assets/icon-512.png`],
    },
    termsConditionsUrl: `${location.origin}/terms`,
    privacyPolicyUrl: `${location.origin}/privacy`,
    features: { email: false, socials: false, onramp: false, swaps: false, send: false, history: false, analytics: false },
    allowUnsupportedChain: false,
    themeMode: "dark",
    // The site's covenant: cyan is a line, never a fill; corners square.
    themeVariables: {
      "--w3m-accent": "#f2f4f9",
      "--w3m-color-mix": "#06080c",
      "--w3m-color-mix-strength": 20,
      "--w3m-border-radius-master": "1px",
      "--w3m-font-family": "inherit",
      "--w3m-z-index": 1000,
    },
  });

  const account = () => {
    const a = kit.getAccount(config);
    const name = a.connector?.name || "";
    return {
      address: a.address || null,
      chainId: a.chainId || null,
      status: a.status,
      walletName: name,
      isSafe: /safe/i.test(name) || a.connector?.id === "safe",
    };
  };

  const handle = {
    kit,
    config,
    open: () => modal.open(),
    account,
    onChange(cb) { return kit.watchAccount(config, { onChange: () => cb(account()) }); },
    isOnBase: () => account().chainId === MANIFEST.chainId,
    async switchToBase() { await kit.switchChain(config, { chainId: MANIFEST.chainId }); },
    async disconnect() { await kit.disconnect(config); },

    /** One contract read on Base. */
    read: (c) => kit.readContract(config, { chainId: MANIFEST.chainId, ...c }),
    /** Many reads in one round trip (multicall); throws on the first failure. */
    async readMany(cs) {
      if (!cs.length) return [];
      const res = await kit.readContracts(config, { contracts: cs.map((c) => ({ chainId: MANIFEST.chainId, ...c })), allowFailure: false });
      return res;
    },
    async ethBalance(address) {
      const b = await kit.getBalance(config, { chainId: MANIFEST.chainId, address });
      return Number(kit.formatUnits(b.value, 18));
    },

    /** Whether the connected wallet can send several calls as one confirmation. */
    async canBatch() {
      try {
        const caps = await kit.getCapabilities(config, { chainId: MANIFEST.chainId });
        const c = caps?.[MANIFEST.chainId] || caps;
        return c?.atomic?.status === "supported" || c?.atomic?.status === "ready" || c?.atomicBatch?.supported === true;
      } catch { return false; }
    },
    /** Dry-run one call as the connected account; throws a readable error when it would fail. */
    async simulate(call) {
      const from = account().address;
      await kit.simulateContract(config, { chainId: MANIFEST.chainId, account: from, address: call.to, abi: call.abi, functionName: call.functionName, args: call.args });
    },
    /** Send one call and wait for it to be mined. Resolves to the hash. `onSent` fires with the hash first. */
    async write(call, onSent) {
      const hash = await kit.writeContract(config, { chainId: MANIFEST.chainId, address: call.to, abi: call.abi, functionName: call.functionName, args: call.args });
      onSent?.(hash);
      await kit.waitForTransactionReceipt(config, { chainId: MANIFEST.chainId, hash });
      return hash;
    },
    /** Send calls as one atomic batch (EIP-5792) and wait. Resolves to the final transaction hash. */
    async sendBatch(calls, onSent) {
      const { id } = await kit.sendCalls(config, {
        chainId: MANIFEST.chainId,
        forceAtomic: true,
        calls: calls.map((c) => ({ to: c.to, abi: c.abi, functionName: c.functionName, args: c.args })),
      });
      onSent?.(id);
      const status = await kit.waitForCallsStatus(config, { id, timeout: 600_000 });
      if (status.status !== "success") throw new Error("The batch did not go through.");
      return status.receipts?.at(-1)?.transactionHash || id;
    },
    errorText,
  };
  return handle;
}

/**
 * A sentence for a wallet or contract error (design canvas board 21, P1).
 * @param {any} e
 */
export function errorText(e) {
  const code = e?.code ?? e?.cause?.code;
  const msg = String(e?.shortMessage || e?.details || e?.message || "");
  if (code === 4001 || /user rejected|denied|rejected the request/i.test(msg)) return "Nothing was sent. You declined it in your wallet.";
  if (code === -32002 || /already pending|request already/i.test(msg)) return "Your wallet has a request waiting. Open it to continue.";
  if (/insufficient funds|gas required exceeds/i.test(msg)) return "Not enough ETH on Base for the network fee.";
  if (/exceeds balance|insufficient balance/i.test(msg)) return "Not enough USDC in this wallet.";
  if (/allowance/i.test(msg)) return "The approval does not cover this amount. Try again.";
  if (/BelowMinRequest/.test(msg)) return "Below the smallest request the vault takes.";
  if (/AbovePerDepositCap|PerDepositCap/.test(msg)) return "Above the largest request the vault takes.";
  if (/TVLCap/.test(msg)) return "The vault is full for now.";
  if (/RequestLocked/.test(msg)) return "This request has locked for its batch, so it can no longer be cancelled.";
  if (/NoticeNotReady|NoticeAlreadyGiven/.test(msg)) return "Not yet. Notice opens once no batch has filled the request in its time.";
  if (/FundIsShutdown|FundNotShutdown/.test(msg)) return "The vault's state changed. Reload the page and try again.";
  if (/QueuePaused|PauseActive/.test(msg)) return "The queue is paused for now. Nothing settles until it ends.";
  if (/Paused|DepositsArePaused|DepositsStopped/.test(msg)) return "Deposits are stopped for now. Redemptions still work.";
  if (/timeout|timed out|fetch failed|network/i.test(msg)) return "Base did not answer. Try again.";
  return msg ? `It did not go through: ${msg.split("\n")[0]}` : "It did not go through. Try again.";
}
