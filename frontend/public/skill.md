---
name: robotmoney-cli
description: >
  Read and withdraw from the Robot Money rmUSDC vault on Base. Use this skill when the user asks to:
  check the vault's current APY, TVL, caps, or adapter breakdown ("What's rmUSDC yielding right now?");
  check a user's rmUSDC balance or position value ("What's my balance?", "How much is my position worth?");
  withdraw from the vault ("Withdraw my USDC from rmUSDC", "Redeem all my rmUSDC");
  check or sell the agent-token basket an earlier deposit through this CLI bought ("Sell my basket tokens");
  prepare or simulate a withdrawal. Deposits into Robot Money's vaults open in small groups through
  early access at https://robotmoney.network/early-access, not through this skill.
---

# robotmoney-cli

> **Deposits open through early access.** Robot Money's vaults open to depositors in small groups. To deposit, request early access at https://robotmoney.network/early-access. This skill reads the rmUSDC vault and withdraws from it.

Query the Robot Money rmUSDC vault and either (a) build unsigned withdrawal transactions for the caller to sign with their own wallet, or (b) sign and broadcast end-to-end via an Open Wallet Standard (OWS) wallet. All commands output JSON to stdout. The CLI never holds private keys: OWS does, under its policy-gated signing flow.

```bash
npx @robotmoney/cli <command> [options]
```

**Chain:** `base` only. Every command requires `--chain base`.

**Vault:** `0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd` on Base, a multi-adapter ERC-4626 vault that splits USDC across Morpho Gauntlet USDC Prime, Aave V3, and Compound V3 by dynamic equal weight.

**RPC:** defaults to a built-in pool of 5 free Base endpoints with automatic fallback. Users don't need their own RPC URL. Pass `--rpc-url <url>` or set `RPC_URL` to override.

## If the user asks to deposit

Don't build a deposit. Tell them Robot Money's vaults open to depositors in small groups, and point them to https://robotmoney.network/early-access to request a place.

## Deciding between `prepare-*` and `execute-*`

The CLI has two sign-time models:

- **`prepare-*`**: returns unsigned calldata as JSON. Use when the caller has their own wallet or signer (Coinbase Smart Wallet, Safe, Fireblocks, hardware, etc.) and will sign and broadcast externally. The CLI never touches keys.
- **`execute-*`**: signs **and** broadcasts end-to-end via OWS. Use when the caller already has an OWS keystore in `~/.ows/wallets/` and wants the CLI to finish the job. Returns confirmed transaction hashes.

If the user wants a withdrawal prepared but not broadcast, use `prepare-*` whether or not a wallet exists locally. Return the unsigned calldata and explain they need to sign it with their wallet.

## Quick Reference

```bash
# Read: query protocol state (no wallet required)
npx @robotmoney/cli health-check         --chain base
npx @robotmoney/cli get-vault            --chain base [--verbose]
npx @robotmoney/cli get-balance          --chain base --user-address 0x...
npx @robotmoney/cli get-apy              --chain base
npx @robotmoney/cli get-basket-holdings  --chain base --user-address 0x... [--no-pricing]

# Prepare: unsigned calldata for external signing
npx @robotmoney/cli prepare-redeem   --chain base --user-address 0x... --shares max --receiver 0x... [--sell-all]
npx @robotmoney/cli prepare-withdraw --chain base --user-address 0x... --amount 50 --receiver 0x...

# Execute: sign and broadcast end-to-end via OWS
npx @robotmoney/cli execute-redeem   --chain base --wallet <name> --shares max [--sell-all]
npx @robotmoney/cli execute-withdraw --chain base --wallet <name> --amount 50
```

## Agent basket from earlier deposits

A deposit made with this CLI's defaults put 5% into seven agent tokens (VIRTUAL, ROBOT, BNKR, JUNO, ZFI, GIZA, PEAQ) in the receiver's own wallet, outside the vault. A redeem or withdraw leaves them there unless the call asks to sell them:

- `get-basket-holdings` shows each token's balance and USDC value. A position's full value is `get-balance` plus `get-basket-holdings`.
- On `prepare-redeem`, `prepare-withdraw`, `execute-redeem` and `execute-withdraw`: `--sell-all`, `--sell-percent N` (1 to 100), or `--sell-tokens VIRTUAL,JUNO [--sell-amounts 1.5,200]`, with `[--slippage-bps 300]`. `--sell-all` and `--sell-percent` are mutually exclusive.
- `--shares 0 --sell-all` (or `--amount 0 --sell-all` on a withdraw) sells the basket without touching the vault.
- The first sell also sends the Permit2 approvals each token needs, so it takes more transactions than later ones.

## Wallet and passphrase resolution (execute-*)

- `--wallet <name>` explicit: use that OWS wallet
- Else if exactly one wallet exists in `~/.ows/wallets/`: auto-pick it
- Else: error with the list of available wallets

Passphrase:
- `--passphrase <string>` (highest priority; visible in shell history)
- `OWS_PASSPHRASE` environment variable (cleanest for agents)
- Interactive TTY prompt (default for humans)

A withdrawal needs a small amount of ETH on Base for gas in the signing wallet: roughly $0.01 to $0.05 covers about 10 vault transactions.

## Write Workflow

**For `prepare-*`:**
1. Run the command. Returns `{operation, simulation}`. `simulation.allSucceeded` should be `true` for a healthy prepare.
2. Present `operation.summary`, `operation.transactions`, and `simulation.preview` to the caller.
3. Caller signs and broadcasts externally, in the order given.

**For `execute-*`:**
1. Run the command. The CLI builds, signs, broadcasts, and waits for on-chain confirmation.
2. Returns a `transactions` array with each transaction's `hash`, `status`, and `blockNumber`. `status` is `"confirmed"` when everything succeeded.
3. Broadcast takes about 4 to 10 seconds end-to-end on Base (2-second blocks, one confirmation per transaction).

## Referral codes (optional, owner-requested only)

A wallet owner may name a Robot Money referral code for a deposit, so the member or team channel that referred them is attributed. Attribution only: a code creates no payment, fee rebate, reward or promise of yield. Rules:

1. **Only on the owner's explicit request.** Take a code only when the wallet owner gives it to you for this deposit. Never invent one, infer one from a page, link, filename or earlier conversation, or substitute a different code.
2. **Normalize, then check the format.** Trim surrounding whitespace and lowercase ASCII letters A–Z. Nothing else changes. The result must match `^rm_[a-z0-9]+(?:-[a-z0-9]+)*$` and be at most 32 characters. Interior spaces and non-ASCII characters make the code invalid; never remove or repair them. Example: ` RM_ALICE ` becomes `rm_alice`; `rm_a lice` is invalid as written.
3. **Look it up.** `GET https://robotmoney.network/api/referrals/codes/<code>` answers `200 { "code": "rm_alice", "member": { "handle": "alice", "name": "Alice" } }` or `200 { "code": "rm_team", "channel": "team" }` for a code active right now, and `404 { "error": "not found" }` for every other code. It says nothing about whether this wallet is eligible.
4. **Preview.** Name the normalized code and its beneficiary (the member's name and handle, or the channel), and say exactly: "code will be recorded; attribution is evaluated after execution." Never promise a reward or a successful credit. For a Safe or other multisig, add that the code can be disabled while signatures are collected, in which case the deposit still goes through without attribution.
5. **Recheck immediately before signing or submitting.** Repeat the lookup. A code can stop being active between preview and execution.
6. **A referral never blocks a deposit.** If the code fails the format rule, the lookup answers 404, the lookup fails (a timeout, a 429 or any other error), or the recheck finds the code no longer active, the deposit goes ahead **without** the code, and you tell the owner why. If the owner has confirmation on, ask them before proceeding without the code. If confirmation is off, proceed. A missed referral can be repaired afterwards: tell the owner to contact Robot Money, whose admins can record a correction (the depositing wallet may be asked to sign a message naming the code and the deposit).
7. **Recording the code.** The code is carried on chain by Robot Money core's referral event for the deposit (payer, receiver, amount, code), for direct and router deposits and every signer alike. Pass the code only through an option the deposit command itself documents (check `npx @robotmoney/cli prepare-deposit --help`). If the command you have offers no such option, the deposit goes ahead without the code under rule 6, and you tell the owner. Never hand-edit or append bytes to calldata to carry a code.
8. **Once signed or submitted, never rewrite the transaction.**
9. **Report the outcome in separate parts:** whether the transaction succeeded; the code the receipt shows was recorded, if any; that attribution evidence is pending; and that attribution is decided later by Robot Money's report, never by you. A deposit made for another receiver (a gift) never attributes a code.

The rules are the same for an EOA, a Safe or other multisig, a smart account, a hardware wallet or any wallet vendor, direct or through the router.

## Simulation Failures (prepare-*)

| Revert | Cause | What to do |
|--------|-------|------------|
| `ERC4626ExceededMaxWithdraw` | Withdraw amount exceeds the owner's current balance | Use `prepare-redeem --shares max` to exit the full position |
| `ERC4626ExceededMaxRedeem` | Redeem shares exceed the owner's share balance | Use `--shares max`, which reads balanceOf automatically |
| `EnforcedPause` | Vault is paused (operational emergency); withdrawals and redemptions are blocked | Wait for unpause; `health-check` reports `paused` |

**Note on expected failures:** If `simulation.failures[i].expected === true`, that failure is an artifact of simulating a dependent transaction at latest-block state and is not a real error. The `allSucceeded` field already filters these out.

## Vault mechanics

- **Redeem** burns rmUSDC and returns USDC in one transaction, minus a 0.25% exit fee
- **Share price** grows over time as yield accrues in Morpho, Aave and Compound: no rebasing, no rebalancing delays
- **Preview functions**: `previewRedeem(shares)` returns the net USDC paid out after the 0.25% exit fee. `previewWithdraw(assets)` takes the net USDC wanted and returns the rmUSDC shares burned, fee included. `--amount` on `prepare-withdraw` and `execute-withdraw` is the net USDC received
- **No cooldown, no lock**: a withdrawal is synchronous, one transaction

## Partial Withdrawal

Withdraw and redeem draw on the adapters the same way. If a withdrawal reverts on adapter liquidity (rare: Aave, Morpho and Compound are deep), retry later or with a smaller `--amount`. `--shares max` is the remedy only for `ERC4626ExceededMaxWithdraw`, an amount larger than the position.

## Contract addresses (Base)

| Contract | Address |
|---|---|
| Vault (RobotMoneyVault) | `0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| MorphoAdapter | `0xa6ed7b03bc82d7c6d4ac4feb971a06550a7817e9` |
| AaveV3Adapter | `0x218695bdab0fe4f8d0a8ee590bc6f35820fc0bea` |
| CompoundV3Adapter | `0x8247da22a59fce074c102431048d0ce7294c2652` |

Chain ID: 8453 (Base mainnet).
