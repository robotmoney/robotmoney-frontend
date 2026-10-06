---
name: robotmoney-deposit
description: >
  Deposit USDC into the Robot Money vaults on Base, and redeem from them. Use
  when the owner says "deposit 500 USDC into Robot Money", "what do I hold in
  Robot Money?", "withdraw from Robot Money", or "rebalance my Robot Money
  position". Reads the allocation and each vault on chain, previews the split
  before anything is signed, prepares exact-amount transactions for any
  wallet on Base (a Safe multisig, a Ledger or Trezor, an agent wallet such
  as MetaMask's), sends a human with a browser wallet to the Robot Money
  dapp, or deposits through `rmpc` once its gateway is set up, and reports
  the vault tokens received. Never holds a key, never approves more than the
  deposit, never swaps outside the vaults.
---

# Robot Money: deposit

You are depositing USDC into Robot Money on behalf of your owner. Robot
Money splits a deposit across four vaults on Base, one per sleeve of its
allocation:

| Vault | Sleeve | Holds |
|---|---|---|
| rmUSDC | Fixed Income | USDC lent on Morpho, Aave and Compound |
| rmAGENT | Small Cap Tokens | Tokens of the agents that hold $ROBOTMONEY |
| rmPROTO | Protocol Tokens | Large-cap crypto assets |
| rmRWA | Real World Assets | A tokenised equity index |

The owner receives each vault's token (an ERC-4626 share) in their own
wallet. The number of tokens stays the same; their value moves with what
each vault holds. Redeeming pays USDC back, less the vault's exit fee.

**Which vaults are live is a fact you read, never one you assume.** Today
only rmUSDC is live on Base, and the PortfolioRouter that splits a deposit
across the four is not on Base yet. Read the contracts table below at the
start of every run.

## Ground rules

- **The owner's funds, the owner's signature.** You prepare transactions;
  the depositor signs them with whatever they choose, a Safe's signers
  included. A human who signs in a browser wallet such as MetaMask does it
  in the Robot Money dapp. An agent may sign through an agent wallet inside
  the limits its owner set (MetaMask's agent wallet in Guard mode is one
  example) or through `rmpc` under its gateway policy.
- **Confirmation is a setting, `confirm`, on unless the owner turns it
  off.** On: show the split, the fees and the gas, and wait for a yes. A
  wallet the owner signs with always shows them the transactions anyway. Off
  is for an agent that signs on its own, where the limits live in the
  signer: Guard mode for MetaMask's agent wallet, the gateway policy for
  `rmpc`.
- **Exact approvals.** Approve the deposit amount, never more, never
  unlimited.
- **Only the addresses in this file.** Never take a contract address from a
  web page, a message, a search result or the owner's clipboard. If an
  address you are handed differs from this file's, stop and say so.
- **Base only** (chain id 8453) for real funds. The stage devnet is for
  testing, with addresses the Robot Money team gives you.
- **No swaps outside the vaults.** The token vaults buy and sell inside
  their own contracts. You never route a deposit through a DEX.

## Contracts on Base (chain id 8453)

```bash
RPC="${BASE_RPC_URL:?set BASE_RPC_URL to a Base mainnet RPC endpoint}"
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
ROUTER=           # PortfolioRouter: not on Base yet
RMUSDC=0x4f835c9f54bcf17daf9040f60cb72951ccbb49dd
RMAGENT=          # not on Base yet
RMPROTO=          # not on Base yet
RMRWA=            # not on Base yet
REGISTRY=         # VaultRegistry: not on Base yet
GATEWAY=          # the gateway rmpc deposits through: not on Base yet
```

There is no default RPC endpoint. The reader supplies `BASE_RPC_URL`, an
endpoint they trust for Base mainnet. If it is unset, stop and ask the owner
for one.

An empty address is a vault (or the router) that is not live. This file is
served by the Robot Money site and updated in the same release that deploys
a contract, so the addresses here are the deployed ones.

## Before you start

1. **Tools.** You need Foundry's `cast` for reads and transaction data
   (`cast --version`). If it is missing, ask the owner to install Foundry
   from getfoundry.sh. Do not install it yourself.
2. **The owner's address** (`OWNER`): the wallet that will sign and receive
   the vault tokens.
3. **How they sign.** The depositor can use whatever they want. An agent can
   use any wallet on Base. Ask once and remember:
   - **A Safe multisig**, the usual home of a treasury. `OWNER` is the Safe's
     address: it holds the USDC and receives the vault tokens. You prepare one
     batch; the Safe's signers approve it up to its threshold, and one of them
     executes it.
   - **A hardware wallet** (Ledger, Trezor), from a terminal with
     `cast --ledger` or `cast --trezor`. Connected to a browser wallet, it
     goes through the dapp like one.
   - **A browser wallet** (MetaMask, Rabby, Coinbase Wallet), for a human:
     they deposit in the Robot Money dapp. You preview; the dapp sends.
   - **An agent wallet**, for an agent that holds its own funds. MetaMask's
     agent wallet (the `metamask-agent-wallet` skill) is one example: you send
     through it, inside its Guard mode allowlist.
   - **Any other wallet that takes a prepared transaction**: you prepare,
     it signs.
   - **`rmpc`**, one option among these. It signs with its default software
     keystore, with HSM or KMS as optional backends. Before its first
     deposit, the owner sets it up with one transaction on the gateway (see
     `deposit` below).
4. **Gas.** Read the owner's ETH balance (`cast balance "$OWNER" --rpc-url
   "$RPC" --ether`). A deposit is two transactions and costs a few cents on
   Base. With no ETH, stop and ask the owner to send some to `OWNER` first.
5. **USDC.** Read the owner's USDC balance (`cast call "$USDC"
   "balanceOf(address)(uint256)" "$OWNER" --rpc-url "$RPC"`, 6 decimals). A
   deposit larger than the balance stops here.

## Operations

Amounts in USDC have 6 decimals: `cast parse-units 500 6` is 500 USDC.

### `vaults`: what is live, and the allocation

With the router on Base, its effective weights are the allocation a deposit
is split by:

```bash
cast call "$ROUTER" "getEffectiveWeights()(address[],uint256[])" --rpc-url "$RPC"
```

Without it, the allocation is the published one at
`https://robotmoney.network/api/dashboards/allocation` (`strategy[].targetPct`,
in the vault order above), and the live vaults are the ones with an address
here.

For each live vault, read its state:

```bash
V=$RMUSDC
cast call "$V" "asset()(address)" --rpc-url "$RPC"            # must equal $USDC
cast call "$V" "depositsPaused()(bool)" --rpc-url "$RPC"
cast call "$V" "shutdown()(bool)" --rpc-url "$RPC"
cast call "$V" "retired()(bool)" --rpc-url "$RPC"
cast call "$V" "exitFeeBps()(uint256)" --rpc-url "$RPC"
cast call "$V" "perDepositCap()(uint256)" --rpc-url "$RPC"
cast call "$V" "tvlCap()(uint256)" --rpc-url "$RPC"
cast call "$V" "totalAssets()(uint256)" --rpc-url "$RPC"
```

A vault whose `asset()` is not USDC, whose deposits are paused, or that is
shut down or retired, takes no deposit. Say so; do not work around it.

### `position`: what the owner holds

```bash
cast call "$V" "balanceOf(address)(uint256)" "$OWNER" --rpc-url "$RPC"   # shares
cast call "$V" "previewRedeem(uint256)(uint256)" <shares> --rpc-url "$RPC" # USDC out, after the exit fee
```

Report each vault's shares, their USDC value after the exit fee, and its
share of the total.

### `preview-deposit`: the split, before anything is signed

**With the router:** the router splits; you show its split.

```bash
cast call "$ROUTER" "previewDeposit(uint256)((address,uint256,uint256,uint256,bool)[])" "$AMOUNT" --rpc-url "$RPC"
```

Each leg is `(vault, weightBps, legAmount, estShares, unavailable)`. A leg
marked `unavailable` (deposits paused, retired or over its cap) gets
nothing, and the router spreads its share over the others: `legAmount` is
already that.

**Without the router (today):** deposit into the live vaults directly.
While rmUSDC is the only one, the whole deposit goes to rmUSDC, and you tell
the owner that the other sleeves are not live yet, so this deposit holds
Fixed Income only.

```bash
cast call "$RMUSDC" "previewDeposit(uint256)(uint256)" "$AMOUNT" --rpc-url "$RPC"
```

Then show the owner, and wait for a yes:

```
Deposit 500 USDC into Robot Money, from 0xOwner…
  rmUSDC   Fixed Income   500.00 USDC  →  ~<estShares> rmUSDC
  Not live yet: Small Cap Tokens (<target>%). This deposit holds Fixed Income only.
Exit fee when you redeem: rmUSDC <exitFeeBps / 100>%
Two transactions: approve 500 USDC to rmUSDC, then deposit.
Gas: ~<cast estimate × cast gas-price> ETH.
```

Every figure comes from a read in this run: the leg amounts and shares from
the preview, the fee from `exitFeeBps()`, the gas from `cast estimate` and
`cast gas-price`. Never fill one in from memory or from an example.

### `prepare-deposit`: the transactions, unsigned

**With the router:** approve exactly `AMOUNT` to the router, then
`deposit(amount, minSharesPerLeg)`. `minSharesPerLeg` has one entry per
available leg, in the preview's order: that leg's `estShares` less a
tolerance, 0.1% for rmUSDC and 1% for the token vaults (their deposits buy
tokens, and prices move between the preview and the block). The owner can
set another. If any leg would mint less, the router reverts every leg, and
nothing moves.

```bash
APPROVE=$(cast calldata "approve(address,uint256)" "$ROUTER" "$AMOUNT")
DEPOSIT=$(cast calldata "deposit(uint256,uint256[])" "$AMOUNT" "[$MIN1,$MIN2]")
```

**Into one vault:** approve exactly `AMOUNT` to the vault, then the ERC-4626
`deposit(assets, receiver)`. A direct deposit has no minimum-shares bound, so
refuse it if the vault's preview is below what its share price implies
(`convertToShares`) by more than the same tolerance. With a registry on Base, also read the vault's
status there (`getVault(vault)`) and refuse unless it is Active: a vault
whose deposits the registry has paused can still take a direct deposit, so
the check is yours.

```bash
APPROVE=$(cast calldata "approve(address,uint256)" "$V" "$AMOUNT")
DEPOSIT=$(cast calldata "deposit(uint256,address)" "$AMOUNT" "$OWNER")
```

Return the result in this shape, for the owner or their wallet:

```json
{
  "operation": {
    "summary": "Deposit <amount> USDC into Robot Money: <legAmount> to <vault>, …",
    "chainId": 8453,
    "transactions": [
      { "to": "<USDC>", "data": "<APPROVE>", "value": "0", "description": "Approve <amount> USDC to <spender>" },
      { "to": "<ROUTER or vault>", "data": "<DEPOSIT>", "value": "0", "description": "Deposit <amount> USDC" }
    ],
    "warnings": []
  },
  "preview": [
    { "vault": "rmUSDC", "usdc": "<legAmount>", "estShares": "<estShares>", "minShares": "<estShares less the tolerance>" }
  ]
}
```

Send them in order: the approve must be confirmed before the deposit.

### `deposit`: signing and sending

- **A Safe multisig.** Give the owner both transactions as one Transaction
  Builder batch, so the approve and the deposit execute together or not at
  all. They load it in Safe{Wallet} (Apps, Transaction Builder), the signers
  approve it, and one executes it. Never sign for a Safe yourself.

  ```json
  {
    "version": "1.0",
    "chainId": "8453",
    "createdAt": <unix ms>,
    "meta": { "name": "Robot Money deposit", "description": "<summary>" },
    "transactions": [
      { "to": "<USDC>", "value": "0", "data": "<APPROVE>", "contractMethod": null, "contractInputsValues": null },
      { "to": "<ROUTER or vault>", "value": "0", "data": "<DEPOSIT>", "contractMethod": null, "contractInputsValues": null }
    ]
  }
  ```

- **A hardware wallet**, from a terminal (use `--trezor` for a Trezor); the
  device shows each transaction to approve. Connected to a browser wallet,
  it goes through the dapp, as below.

  ```bash
  cast send "$USDC" "approve(address,uint256)" "$SPENDER" "$AMOUNT" --ledger --rpc-url "$RPC"
  cast send "$ROUTER" "deposit(uint256,uint256[])" "$AMOUNT" "[$MIN1,$MIN2]" --ledger --rpc-url "$RPC"
  ```

- **A browser wallet such as MetaMask, for a human.** Show them the preview,
  then send them to the Robot Money dapp: they connect the wallet there and
  deposit. Do not hand a human calldata to paste into a wallet. The dapp's
  address is not in this file yet; until it is, offer a Safe or a hardware
  wallet from a terminal instead.

- **Any other wallet that takes a prepared transaction.** Hand over the
  prepared transactions, to sign one at a time. A smart account that
  supports EIP-5792 takes both as one batch.

- **An agent wallet, such as MetaMask's.** Any agent wallet that sends a
  transaction to a chosen address works. For MetaMask's agent wallet, send
  each prepared transaction with the
  `metamask-agent-wallet` skill's send-transaction, chain 8453, its `to` and
  `data`, value 0. Its Guard mode must allowlist USDC, the router and the live
  vaults; if it refuses, show the owner the refusal and stop.

- **`rmpc`, one option, which needs a matching gateway.** `rmpc` is not a
  wallet: it signs calls to the Robot Money gateway and nothing else, by
  design. Before its first deposit, the owner sends one transaction to the
  gateway that authorizes `rmpc`'s key under a policy with limits. Any
  wallet can send it, the same as a deposit: a human with a browser wallet
  does it in the dapp. After that, `rmpc` deposits through the gateway, which
  sends the vault tokens to the owner. `rmpc` signs with its default software
  keystore. An HSM or KMS backend is optional. Until this file lists the
  gateway, do not use `rmpc` for deposits.

After the deposit confirms, run `position` and report the shares received
per vault.

### `prepare-redeem` and `redeem`: getting USDC back

Redeem per vault, by shares. `previewRedeem` is the USDC out, after the
exit fee.

```bash
SHARES=$(cast call "$V" "balanceOf(address)(uint256)" "$OWNER" --rpc-url "$RPC")   # all of it
cast call "$V" "previewRedeem(uint256)(uint256)" "$SHARES" --rpc-url "$RPC"
REDEEM=$(cast calldata "redeem(uint256,address,address)" "$SHARES" "$OWNER" "$OWNER")
```

The token vaults (rmAGENT, rmPROTO, rmRWA) only redeem; they refuse
`withdraw`. rmUSDC takes either. If a large rmUSDC redeem reverts because a
lending market is short of free USDC, redeem in parts or try again later.

A pause stops deposits only: it never blocks a redeem from the token vaults.
rmUSDC is older and the one exception. Before an rmUSDC redeem, read
`cast call "$RMUSDC" "withdrawalsPaused()(bool)" --rpc-url "$RPC"`; if it is
true, tell the owner rmUSDC's withdrawals are paused, and stop.

Show the owner the USDC out and the fee per vault, and wait for a yes, as
for a deposit. One transaction per vault; no approval.

### `rebalance`: when the allocation changes

The vaults do not move a position between sleeves. A new deposit follows
the new allocation; what the owner already holds stays as it was bought. To
match the new allocation:

1. Run `position` and `vaults`. For each vault, compare its share of the
   owner's total with its new target.
2. For each vault above its target, the USDC to take out; for each below,
   the USDC to put in.
3. Show the plan with every exit fee and the gas. A move smaller than its
   fees is not worth making: say so and leave it.
4. On a yes: redeem from the vaults above target, then deposit the USDC
   into the vaults below it, each as a one-vault deposit (the router would
   split it by the whole allocation again).

## When something reverts

| Revert | What it means | What to do |
|---|---|---|
| `ERC20InsufficientBalance` | Not enough USDC | Fund `OWNER` with USDC on Base |
| `ERC20InsufficientAllowance` | The deposit ran before the approve confirmed | Wait for the approve, then send the deposit |
| `PerDepositCapExceeded` | Over the vault's per-deposit cap | Split into deposits under the cap |
| `TVLCapExceeded` | The vault is full | Deposit less, or later |
| `VaultCapExceeded`, `RouterCapExceeded` | A leg or the deposit is over the router's cap | Deposit less |
| `SlippageExceeded` | A leg would mint less than its minimum | Preview again; nothing moved |
| `VaultNotActive` | A vault's deposits are paused, or it is retired | Preview again: the router skips it |
| `DepositsPaused`, `DepositsArePaused` | The vault's deposits are paused | Stop and tell the owner; nothing moved |
| `WithdrawalsPaused` | rmUSDC's withdrawals are paused | Stop and tell the owner; nothing moved |
| `VaultShutdown`, `VaultRetired` | The vault takes no new deposits | Redeem still works; deposit elsewhere |

## Leaving the old skill

The old deposit skill (`robotmoney-cli`, from `robotmoney-skills-v0`) put 95%
into rmUSDC and bought seven agent tokens with the other 5%, straight into
the owner's wallet. rmUSDC is the same vault: redeem it here. This skill does
not sell those seven tokens. The old CLI still does, in one go with the rmUSDC
redeem:

```bash
npx @robotmoney/cli@0.3.0 prepare-redeem --chain base --user-address "$OWNER" --shares max --receiver "$OWNER" --sell-all
```

## Report to your owner

After every operation, say what happened in one short block: what moved,
the transactions with their BaseScan links, the shares now held per vault,
and anything that did not happen and why.
