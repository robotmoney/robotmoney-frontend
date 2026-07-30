---
name: robotmoney-cli
description: >
  Interact with the Robot Money stablecoin yield vault on Base. Use this skill when the user asks to:
  check the vault's current APY, TVL, caps, or adapter breakdown ("What's rmUSDC yielding right now?");
  check a user's rmUSDC balance or position value ("What's my balance?", "How much is my position worth?");
  deposit USDC into the vault ("Deposit 100 USDC into Robot Money", "Put some USDC into rmUSDC");
  withdraw from the vault ("Withdraw my USDC from rmUSDC", "Redeem all my rmUSDC");
  bootstrap a new wallet for an agent or machine that doesn't have one yet ("I want to deposit but don't have a wallet", "Create a wallet for me and deposit 100 USDC");
  actually send a transaction end-to-end ("Execute the deposit", "Actually deposit it, don't just prepare");
  prepare or simulate any Robot Money vault transaction.
---

# robotmoney-cli

> **Experimental (pre-v1.0)** — Command syntax, response schemas, and available operations may change. Always verify critical outputs independently.

Query the Robot Money stablecoin vault and either (a) build unsigned transactions for the caller to sign with their own wallet, or (b) sign and broadcast end-to-end via an Open Wallet Standard (OWS) wallet. All commands output JSON to stdout. The CLI never holds private keys — OWS does, under its policy-gated signing flow.

```bash
npx @robotmoney/cli <command> [options]
```

**Chain:** `base` only at launch. Every command requires `--chain base`.

**Vault:** `0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd` on Base — a multi-adapter ERC-4626 vault that splits USDC across Morpho Gauntlet USDC Prime, Aave V3, and Compound V3 by dynamic equal weight.

**Basket leg:** `prepare-deposit` and `execute-deposit` also buy a fixed 7-token agent basket (VIRTUAL, ROBOT, BNKR, JUNO, ZFI, GIZA, PEAQ) atomically via Uniswap UniversalRouter — 95% to vault, 5% across the basket by default. `prepare-redeem` / `prepare-withdraw` (and their `execute-*` siblings) can sell back any subset. See [references/basket.md](references/basket.md).

**RPC:** defaults to a built-in pool of 5 free Base endpoints with automatic fallback. Users don't need their own RPC URL. Pass `--rpc-url <url>` or set `RPC_URL` if you want to override.

## Target users

This skill is for **AI agents and autonomous machines** — anything with a wallet (or the need for one) that wants diversified USDC yield. Works the same whether you're a Claude Code session, a Cursor agent, an autonomous trading bot, an IoT device, or a peaq-network machine. Not a retail-wallet UX — all output is JSON and meant to be parsed, not read by humans.

## Deciding between `prepare-*` and `execute-*`

The CLI has two sign-time models:

- **`prepare-*`** — returns unsigned calldata as JSON. Use when the caller has their own wallet/signer (Coinbase Smart Wallet, Safe, Fireblocks, hardware, etc.) and will sign and broadcast externally. The CLI never touches keys.
- **`execute-*`** — signs **and** broadcasts end-to-end via OWS. Use when the caller has run `create-wallet` (or has any OWS keystore in `~/.ows/wallets/`) and wants the CLI to finish the job. Returns confirmed transaction hashes.

### If the user asks to deposit/withdraw and has not provided a wallet address

1. Ask: *"Do you already have a wallet, or should I create a new one for you via Open Wallet Standard?"*
2. **If no wallet** → run `create-wallet`, print the generated address + funding instructions (USDC **and** a small amount of ETH for gas on Base), then suggest `execute-*` for the deposit once funds land
3. **If they have one** → ask for the address, then use `prepare-*` — they'll sign externally

### If the user just wants a transaction prepared (not broadcast)

Use `prepare-*` regardless of whether a wallet exists locally. Return the unsigned calldata and explain they need to sign it with their wallet.

## Response Schemas

- **[Read commands](references/read.md)** — exact JSON shapes for `health-check`, `get-vault`, `get-balance`, `get-apy`
- **[Write commands](references/write.md)** — exact JSON shapes for `prepare-*`, `execute-*`, `create-wallet`
- **[Basket leg](references/basket.md)** — token list, defaults, new flags, response shape, `get-basket-holdings`

## Quick Reference

```bash
# Wallet — bootstrap one if the agent/machine doesn't have one yet
npx @robotmoney/cli create-wallet [--label <string>] [--storage-path <dir>]

# Read — query protocol state (no wallet required)
npx @robotmoney/cli health-check         --chain base
npx @robotmoney/cli get-vault            --chain base [--verbose]
npx @robotmoney/cli get-balance          --chain base --user-address 0x...
npx @robotmoney/cli get-apy              --chain base
npx @robotmoney/cli get-basket-holdings  --chain base --user-address 0x... [--no-pricing]

# Prepare — unsigned calldata for external signing (95% vault + 5% basket by default)
npx @robotmoney/cli prepare-deposit  --chain base --user-address 0x... --amount 100 --receiver 0x... \
    [--no-basket | --basket-only] [--slippage-bps 300]
npx @robotmoney/cli prepare-redeem   --chain base --user-address 0x... --shares max --receiver 0x... \
    [--sell-all | --sell-percent N | --sell-tokens VIRTUAL,JUNO [--sell-amounts 1.5,200]] [--slippage-bps 300]
npx @robotmoney/cli prepare-withdraw --chain base --user-address 0x... --amount 50 --receiver 0x... \
    [...same basket-sell flags...]

# Execute — sign + broadcast end-to-end via OWS
npx @robotmoney/cli execute-deposit  --chain base --wallet <name> --amount 100 [--no-basket | --basket-only]
npx @robotmoney/cli execute-redeem   --chain base --wallet <name> --shares max [--sell-all]
npx @robotmoney/cli execute-withdraw --chain base --wallet <name> --amount 50 [--sell-all]
```

## Wallet & passphrase resolution (execute-*)

- `--wallet <name>` explicit → use that OWS wallet
- Else if exactly one wallet exists in `~/.ows/wallets/` → auto-pick it
- Else → error with list of available wallets

Passphrase:
- `--passphrase <string>` (highest priority; visible in shell history)
- `OWS_PASSPHRASE` environment variable (cleanest for agents)
- Interactive TTY prompt (default for humans)

## Funding a newly-created wallet

`create-wallet` returns a new EVM address. Before running `execute-*`, fund it with:
1. **USDC** on Base — the amount you want to deposit. Per-deposit cap is 5,000 USDC.
2. **A small amount of ETH on Base for gas** — roughly $0.01–0.05 covers ~10 vault transactions. Without ETH, every `execute-*` will fail at gas check.

Funding paths: Coinbase Base withdrawal, https://bridge.base.org, or any CEX/DEX that supports Base.

## Write Workflow

**For `prepare-*`:**
1. Run the command. Returns `{operation, simulation}`. `simulation.allSucceeded` should be `true` for a healthy prepare.
2. Present `operation.summary`, `operation.transactions`, and `simulation.preview` to the caller.
3. Caller signs and broadcasts externally. Approve + deposit is a two-tx sequence — broadcast them in order.

**For `execute-*`:**
1. Run the command. CLI builds, signs, broadcasts, and waits for on-chain confirmation.
2. Returns a `transactions` array with each tx's `hash`, `status`, and `blockNumber`. `status` will be `"confirmed"` when everything succeeded.
3. Broadcast takes ~4–10 seconds end-to-end on Base (2-second blocks, one confirmation per tx). Don't worry about the delay.

## Simulation Failures (prepare-*)

| Revert | Cause | What to do |
|--------|-------|------------|
| `ERC20InsufficientAllowance` | USDC allowance for the vault is below the deposit amount | With `prepare-deposit`, simulation pre-applies the approval via state override, so this shouldn't appear. If it does, it's from a different code path — check the caller's approval flow. |
| `ERC20InsufficientBalance` | User lacks USDC | Fund the wallet with USDC on Base first |
| `ERC4626ExceededMaxDeposit` | Deposit exceeds vault's max for this receiver | Reduce amount; check TVL and per-deposit caps |
| `ERC4626ExceededMaxWithdraw` | Withdraw amount exceeds the owner's current balance | Use `prepare-redeem --shares max` to exit the full position |
| `ERC4626ExceededMaxRedeem` | Redeem shares exceed the owner's share balance | Use `--shares max`, which reads balanceOf automatically |
| `TVLCapExceeded` | Deposit would push total vault assets above the TVL cap ($100,000) | Reduce amount or wait for cap raise |
| `PerDepositCapExceeded` | Single deposit exceeds the per-deposit cap ($5,000) | Split into multiple deposits under the cap |
| `VaultShutdown` | Vault is permanently shut down — deposits disabled | Withdrawals still work; no new deposits accepted |
| `EnforcedPause` | Vault is paused (operational emergency) | Wait for unpause; withdrawals may still be available |
| `NoActiveAdapters` | No adapters are active | Operator attention required before any deposit |

**Note on expected failures:** If `simulation.failures[i].expected === true`, that failure is an artifact of simulating a dependent tx at latest-block state and is not a real error. The `allSucceeded` field already filters these out.

## Vault mechanics

- **Deposit** mints rmUSDC shares and atomically routes USDC across active adapters by equal weight (3 adapters → 33.33% each)
- **Redeem** burns rmUSDC and returns USDC in one transaction, minus a 0.25% exit fee
- **Share price** grows over time as yield accrues in Morpho / Aave / Compound — no rebasing, no rebalancing delays
- **Preview functions** (`previewRedeem`, `previewWithdraw`) return NET USDC after fee — the caller-side exit amount
- **No cooldown, no lock** — deposit and withdraw are both synchronous, one transaction each

## Partial Withdrawal

If `prepare-withdraw --amount <large>` simulation fails due to insufficient adapter liquidity (rare — Aave/Morpho/Compound are deep), use `prepare-redeem --shares max` instead. It pulls proportionally from all adapters and caps at what's actually available.

## Contract addresses (Base)

| Contract | Address |
|---|---|
| Vault (RobotMoneyVault) | `0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| MorphoAdapter | `0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9` |
| AaveV3Adapter | `0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea` |
| CompoundV3Adapter | `0x8247da22a59fce074c102431048d0ce7294c2652` |

Chain ID: 8453 (Base mainnet).
