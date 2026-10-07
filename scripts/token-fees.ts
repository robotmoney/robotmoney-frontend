// How much $ROBOTMONEY the prop wallets hold, and what the token's trading fees
// earn the protocol, read on demand from Base and GeckoTerminal (RM-156).
//
//   bun scripts/token-fees.ts          # report
//   bun scripts/token-fees.ts --json   # the same numbers as JSON
//
// $ROBOTMONEY launched through Bankr on Doppler, not Clanker. Every swap in its
// Uniswap v4 pool pays an LP fee (1.2% once the launch decay ended), and
// Doppler's locker splits that fee between the beneficiaries stored at launch.
// The locker keeps a running total of every fee it has collected from the pool
// (getCumulatedFees0/1) and, per beneficiary, the total at its last claim
// (getLastCumulatedFees0/1), so for a beneficiary holding `shares` (WAD):
//
//   lifetime  = cumulated × shares / 1e18
//   claimable = (cumulated − lastCumulated) × shares / 1e18
//             + what collectFees(poolId) would still pull out of the pool
//
// Lifetime assumes the share was the same since launch: it was, 57% throughout,
// moved from the launch wallet to the primary prop wallet with updateBeneficiary.
// Fees are paid in the swap's input token, so they accrue in WETH (buys) and in
// $ROBOTMONEY (sells); USD values below use today's prices.
//
// The monthly figures are an ESTIMATE: GeckoTerminal's daily pool volume × the
// LP fee × our share. GeckoTerminal keeps about six months of daily candles, so
// the launch month falls out of the table first; the lifetime line has it. Exact
// claims by month need eth_getLogs over the locker's Release events, which the
// public Base RPC caps at 500 blocks a call; set BASE_RPC_URL to a keyed node to
// add that.
//
// No dependencies: raw JSON-RPC with fixed selectors. The prop-wallet list
// mirrors resolvePropWallets() in backend/src/config.ts (which cannot be
// imported here: it requires DATABASE_URL at load) and honours the same
// PROP_WALLET_ADDRESSES and BASE_RPC_URL overrides.

export {}; // a module, so its top-level await and names stay its own

const RPC_URL = process.env.BASE_RPC_URL || "https://mainnet.base.org";
const GECKO = "https://api.geckoterminal.com/api/v2";

const ROBOTMONEY = "0x65021a79aeef22b17cdc1b768f5e79a8618beba3";
const WETH = "0x4200000000000000000000000000000000000006";
const SUPPLY = 100_000_000_000;
// Doppler contracts for this launch, read off its deploy transaction
// (0xf7d157013065523e9616e58f83e0cb45d004ed4b0bdd8165e7e5a6302d7a377f).
const AIRLOCK = "0x660eaaedebc968f8f3694354fa8ec0b4c5ba8d12";
const LOCKER = "0xd59ce43e53d69f190e15d9822fb4540dccc91178"; // DecayMulticurveInitializer
const HOOK = "0xbb7784a4d481184283ed89619a3e3ed143e1adc0"; // DecayMulticurveInitializerHook
const POOL_ID = "0xcece56fd6eb8fcbc6c45af8181bfe71ea6057770630490cac36dbbc4aa27a4a6"; // currency0 WETH, currency1 ROBOTMONEY
// The wallet that launched the token and held the 57% share until it moved it.
const LAUNCH_WALLET = "0xeaec194b018d71f93313df12c6271b29dfddd4fb";
// The 1.9% leg. No public label; Basescan shows it funded by the same address as
// Bankr's integrator wallet, and Bankr describes this part of the split as
// "ecosystem + launchers".
const ECOSYSTEM_WALLET = "0x2cdd33d6ff2a897180c7f4e5a20f018bf0c16fd1";

const PROP_WALLET_NAMES = ["Primary", "Stablecoin Strategy 1", "Stablecoin Strategy 2"];
const PROP_WALLETS = (process.env.PROP_WALLET_ADDRESSES
  ? process.env.PROP_WALLET_ADDRESSES.split(",").map((s) => s.trim()).filter(Boolean)
  : [
      "0xfbc2cc30f0674ed0244ee1f0ba7864423230c9d6",
      "0x422c906083ca40b7e055b811d517f03bbbef8eee",
      "0x8d0c331e45beca4184b758f3049f8897aabb9442",
    ]
).map((a) => a.toLowerCase());

const SEL = {
  balanceOf: "0x70a08231",
  getShares: "0x5ebb58fb",
  getCumulatedFees0: "0xcb7dd8f2",
  getCumulatedFees1: "0x5a302347",
  getLastCumulatedFees0: "0x2b1fd599",
  getLastCumulatedFees1: "0x1564cf6c",
  collectFees: "0x817db73b",
  getBeneficiaries: "0x1cab59a4",
  getFeeScheduleOf: "0x10d052f2",
  getAssetData: "0x1652e7b7",
  owner: "0x8da5cb5b",
};

const WAD = 10n ** 18n;
const word = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const words = (data: string) => (data.replace(/^0x/, "").match(/.{64}/g) ?? []).map((w) => BigInt("0x" + w));
const addr = (w: bigint) => "0x" + w.toString(16).padStart(40, "0");
const toUnits = (raw: bigint) => Number(raw) / 1e18;

async function rpc(method: string, params: unknown[]): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    // The public node rate-limits per IP; back off and retry rather than fail the report.
    if ((res.status === 429 || res.status >= 500) && attempt < 6) {
      await Bun.sleep(500 * 2 ** attempt);
      continue;
    }
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result ?? "0x";
  }
}

const call = (to: string, data: string, from?: string) => rpc("eth_call", [{ to, data, ...(from ? { from } : {}) }, "latest"]);

async function gecko<T>(path: string): Promise<T> {
  const res = await fetch(GECKO + path, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GeckoTerminal ${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

async function main() {
  const json = process.argv.includes("--json");

  const prices = await gecko<{ data: { attributes: { token_prices: Record<string, string> } } }>(
    `/simple/networks/base/token_price/${ROBOTMONEY},${WETH}`,
  );
  const rmUsd = Number(prices.data.attributes.token_prices[ROBOTMONEY]);
  const wethUsd = Number(prices.data.attributes.token_prices[WETH]);

  // Holdings.
  const holdings = [];
  for (const [i, wallet] of PROP_WALLETS.entries()) {
    const amount = toUnits(BigInt(await call(ROBOTMONEY, SEL.balanceOf + word(wallet))));
    holdings.push({ name: PROP_WALLET_NAMES[i] ?? `Wallet ${i + 1}`, address: wallet, amount, valueUsd: amount * rmUsd });
  }
  const held = holdings.reduce((a, h) => a + h.amount, 0);

  // Who is who: Bankr is the launch's integrator, Doppler is the Airlock's owner.
  const assetData = words(await call(AIRLOCK, SEL.getAssetData + word(ROBOTMONEY)));
  const integrator = addr(assetData[9]!);
  const dopplerOwner = addr(words(await call(AIRLOCK, SEL.owner))[0]!);
  const label = (a: string) => {
    const p = PROP_WALLETS.indexOf(a);
    if (p >= 0) return `${PROP_WALLET_NAMES[p] ?? "Prop"} prop wallet`;
    if (a === integrator) return "Bankr (integrator)";
    if (a === dopplerOwner) return "Doppler (protocol owner)";
    if (a === LAUNCH_WALLET) return "Launch wallet";
    if (a === ECOSYSTEM_WALLET) return "Ecosystem (reserved by Bankr at launch)";
    return "Unlabelled";
  };

  // Current shares: everyone named at launch, plus the prop wallets a share may have moved to.
  const ben = words(await call(LOCKER, SEL.getBeneficiaries + word(ROBOTMONEY)));
  const launchBeneficiaries: string[] = [];
  for (let i = 0; i < Number(ben[1] ?? 0n); i++) launchBeneficiaries.push(addr(ben[2 + 2 * i]!));
  const split = [];
  for (const a of new Set([...launchBeneficiaries, ...PROP_WALLETS])) {
    const shares = BigInt(await call(LOCKER, SEL.getShares + word(POOL_ID) + word(a)));
    if (shares > 0n) split.push({ address: a, label: label(a), shares, pct: Number((shares * 10000n) / WAD) / 100 });
  }
  split.sort((x, y) => (y.shares > x.shares ? 1 : -1));

  const schedule = words(await call(HOOK, SEL.getFeeScheduleOf + word(POOL_ID)));
  const lpFee = Number(schedule[2] ?? 0n) / 1e6; // endFee, in hundredths of a basis point

  // Fees to the protocol's share, held by the prop wallets.
  const cum0 = BigInt(await call(LOCKER, SEL.getCumulatedFees0 + word(POOL_ID)));
  const cum1 = BigInt(await call(LOCKER, SEL.getCumulatedFees1 + word(POOL_ID)));
  const ours = split.filter((s) => PROP_WALLETS.includes(s.address));
  const ourShares = ours.reduce((a, s) => a + s.shares, 0n);
  let pending0 = 0n;
  let pending1 = 0n;
  for (const s of ours) {
    const last0 = BigInt(await call(LOCKER, SEL.getLastCumulatedFees0 + word(POOL_ID) + word(s.address)));
    const last1 = BigInt(await call(LOCKER, SEL.getLastCumulatedFees1 + word(POOL_ID) + word(s.address)));
    pending0 += ((cum0 - last0) * s.shares) / WAD;
    pending1 += ((cum1 - last1) * s.shares) / WAD;
  }
  // Fees still sitting in the pool: simulate the collect, which moves nothing.
  const [uncollected0 = 0n, uncollected1 = 0n] = ours.length
    ? words(await call(LOCKER, SEL.collectFees + word(POOL_ID), ours[0]!.address))
    : [];
  pending0 += (uncollected0 * ourShares) / WAD;
  pending1 += (uncollected1 * ourShares) / WAD;

  const lifetimeWeth = toUnits((cum0 * ourShares) / WAD);
  const lifetimeRm = toUnits((cum1 * ourShares) / WAD);
  const claimWeth = toUnits(pending0);
  const claimRm = toUnits(pending1);
  const ourPct = Number((ourShares * 10000n) / WAD) / 10000;

  // Monthly estimate from the pool's daily volume.
  const ohlcv = await gecko<{ data: { attributes: { ohlcv_list: number[][] } } }>(
    `/networks/base/pools/${POOL_ID}/ohlcv/day?aggregate=1&limit=1000&currency=usd`,
  );
  const days = [...ohlcv.data.attributes.ohlcv_list].sort((a, b) => a[0]! - b[0]!);
  const months = new Map<string, { days: number; volumeUsd: number }>();
  for (const d of days) {
    const key = new Date(d[0]! * 1000).toISOString().slice(0, 7);
    const m = months.get(key) ?? { days: 0, volumeUsd: 0 };
    m.days++;
    m.volumeUsd += d[5]!;
    months.set(key, m);
  }
  const lastDays = (n: number) => days.slice(-n).reduce((a, d) => a + d[5]!, 0);
  const monthly = [...months].map(([month, m]) => ({ month, ...m, oursUsd: m.volumeUsd * lpFee * ourPct }));

  const report = {
    asOf: new Date().toISOString(),
    prices: { robotmoneyUsd: rmUsd, wethUsd },
    holdings: { wallets: holdings, total: held, totalUsd: held * rmUsd, pctOfSupply: (held / SUPPLY) * 100 },
    feeSplit: split.map(({ address, label, pct }) => ({ address, label, pct })),
    lpFeePct: lpFee * 100,
    lifetime: { weth: lifetimeWeth, robotmoney: lifetimeRm, usdAtTodaysPrices: lifetimeWeth * wethUsd + lifetimeRm * rmUsd },
    claimable: { weth: claimWeth, robotmoney: claimRm, usd: claimWeth * wethUsd + claimRm * rmUsd },
    estimate: {
      basis: `GeckoTerminal daily volume × ${+(lpFee * 100).toFixed(2)}% × ${+(ourPct * 100).toFixed(2)}%`,
      monthly,
      last30DaysUsd: lastDays(30) * lpFee * ourPct,
      last7DaysUsd: lastDays(7) * lpFee * ourPct,
    },
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const n = (v: number, d = 0) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const usd = (v: number) => "$" + n(v);
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  console.log(`$ROBOTMONEY prop wallets and fees, ${report.asOf.slice(0, 16).replace("T", " ")} UTC`);
  console.log(`Price $${rmUsd.toPrecision(3)}, WETH ${usd(wethUsd)}\n`);
  console.log("Holdings");
  for (const h of holdings) console.log(`  ${h.name.padEnd(22)} ${short(h.address)}  ${n(h.amount).padStart(15)}  ${usd(h.valueUsd).padStart(9)}`);
  console.log(`  ${"Total".padEnd(34)} ${n(held).padStart(15)}  ${usd(held * rmUsd).padStart(9)}  ${n(report.holdings.pctOfSupply, 2)}% of supply\n`);
  console.log(`Fee split (${n(lpFee * 100, 1)}% swap fee, live shares from the Doppler locker)`);
  for (const s of split) console.log(`  ${n(s.pct, 1).padStart(5)}%  ${short(s.address)}  ${s.label}`);
  console.log(`\nOur ${n(ourPct * 100, 1)}%, exact, from the locker`);
  console.log(`  Lifetime   ${n(lifetimeWeth, 2)} WETH + ${n(lifetimeRm)} $ROBOTMONEY  (${usd(report.lifetime.usdAtTodaysPrices)} at today's prices)`);
  console.log(`  Claimable  ${n(claimWeth, 4)} WETH + ${n(claimRm)} $ROBOTMONEY  (${usd(report.claimable.usd)})\n`);
  console.log(`Our share by month, estimated (${report.estimate.basis})`);
  for (const m of monthly) console.log(`  ${m.month}  ${String(m.days).padStart(2)} days  volume ${usd(m.volumeUsd).padStart(11)}  ours ${usd(m.oursUsd).padStart(8)}`);
  console.log(`  Last 30 days ${usd(report.estimate.last30DaysUsd)}, last 7 days ${usd(report.estimate.last7DaysUsd)}`);
}

await main();
