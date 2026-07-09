// One-time backfill data for the continuous /performance history (issue #84).
//
// Ported verbatim from the baked walletPerfView series that used to live in the
// frontend (alpine/views.js `labels` + `assets[].aum`, Mar 18–Jun 26 2026).
// This is the carried-forward pre-launch history the daily sampler accumulates
// onto — gap-free per-day balance reconstruction across the pre-launch window
// would need an archive indexer (explicitly out of #84 scope), so these seeded
// USD values ARE that history. db/seed.ts inserts them idempotently
// (ON CONFLICT DO NOTHING on the (sample_date, symbol) natural key).
//
// A per-asset value of 0 means "not held that day": those (date, symbol) slots
// are intentionally NOT seeded, so byAsset stays sparse (mirroring the
// intermittent ZYFAI/GIZA/SP500 columns) while the day's totalUsd still equals
// the sum of the held legs — identical to the retired baked `totalAum`.

// Labels index-aligned to every aum[] below (2026).
const LABELS = ["Mar 18","Mar 19","Mar 20","Mar 21","Mar 22","Mar 23","Mar 25","Mar 26","Mar 27","Mar 28","Mar 29","Mar 30","Mar 31","Apr 1","Apr 2","Apr 3","Apr 4","Apr 5","Apr 6","Apr 7","Apr 8","Apr 9","Apr 10","Apr 11","Apr 12","Apr 13","Apr 14","Apr 15","Apr 16","Apr 17","Apr 18","Apr 19","Apr 20","Apr 21","Apr 22","Apr 23","Apr 24","Apr 25","Apr 26","Apr 27","Apr 28","Apr 29","Apr 30","May 1","May 2","May 3","May 4","May 5","May 6","May 7","May 8","May 9","May 10","May 11","May 12","May 13","May 14","May 15","May 16","May 17","May 18","May 19","May 20","May 21","May 22","May 23","May 24","May 25","May 26","May 27","May 28","May 29","May 30","May 31","Jun 1","Jun 2","Jun 3","Jun 5","Jun 6","Jun 7","Jun 8","Jun 9","Jun 10","Jun 11","Jun 12","Jun 13","Jun 14","Jun 15","Jun 16","Jun 17","Jun 18","Jun 19","Jun 20","Jun 21","Jun 22","Jun 23","Jun 24","Jun 25","Jun 26"];

// Per-asset USD (aum) series, index-aligned to LABELS. Symbol → colour/group is
// carried by config.resolveTrackedAssets; here we only need the USD values.
const AUM: Record<string, number[]> = {
  "USDC": [0,0,0,0,0,0,0,9962,9966,9955,9912,9951,9951,9912,10012,9951,9942,9936,9892,9971,9955,9981,9945,9921,9895,9946,943,935,934,942,940,937,943,939,939,939,937,938,937,934,937,940,933,938,935,934,936,934,941,942,935,942,935,936,936,936,939,935,936,942,941,941,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,9068,9007,9987,10006,14463,14532,14448,14442,14443,14420,14550,9042,9026,9021,9016,9054,9072,8994,9016,8995,9042,9052],
  "ZYFAI-SS1": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4500,4501,4501,4501,4502,4503,4503,4504,4505,4505,4505,4506,4507,4507,4508,4508,4509,4509,4510,4510,4511,4511,4511,4512,4513,4513,4514,4514,4515,4515,4516,4516,4517,4517,4518,4518,4519,4520,4520,4521,4521,4521,4522,4523,4523,4524,4524,4525,4526,4526,4527,4528,4528,4528,4529,4529,4530,4530,4531,4532,4532,4533,4533,4534,4535,4535,4536,4536,4537,4537,4538,4538],
  "GIZA-SS1": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4500,4501,4502,4502,4502,4503,4504,4504,4505,4505,0,0,4507,4508,0,0,0,0,0,0,4511,4512,4512,4513,4514,4514,4514,4515,4515,4516,4517,4517,4517,4519,4519,4519,4520,4520,4521,4522,4523,4523,4524,4524,4524,4524,4524,4524,4524,4524,4524,4524,4524,4524,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  "WETH": [21519,20841,20441,20464,19855,19484,22252,13364,13758,14408,14743,15273,15764,16231,16268,16201,16592,16763,17480,17541,18784,18648,19230,20226,20399,20541,19670,20353,20780,18206,18285,18000,17590,18618,19211,20799,20740,20959,21324,21859,21617,22125,21964,22553,23683,24398,24796,26179,26245,26359,25862,26324,26582,27418,27417,26970,27273,28545,28010,27838,28674,28147,0,0,0,0,0,0,0,0,0,0,0,0,0,9478,9003,111,214,23424,24663,25891,24878,24510,25637,25515,25930,26578,28030,27742,26975,26426,26261,26872,26454,26553,25682,24916,24194],
  "ETH": [0,0,0,0,0,0,2137,2069,2042,1995,2004,2031,2072,2100,2083,2044,2048,2059,2133,2106,2233,2181,2188,2249,2222,2193,2343,2323,2371,2426,2437,2356,2271,2320,2307,2395,2337,2309,2319,2360,2294,2290,2251,2254,2293,2323,2348,2371,2377,2355,2288,2314,2332,2372,2342,2286,2255,2297,2223,2180,2191,2105,105,106,106,104,106,104,105,103,101,100,100,101,101,100,93,88,80,78,82,85,82,80,84,83,84,86,91,90,87,86,85,87,86,86,83,81,78],
  "ROBOTMONEY": [51300,45207,36397,31594,27998,27253,38817,35631,35013,45389,49311,45897,43041,39798,34421,40995,37994,36316,37678,39430,41470,46311,53361,42195,42296,42907,44926,42454,47711,48799,47545,41722,32117,31433,24208,27443,25760,21947,19920,18950,24315,28661,32806,32673,36368,33091,31319,41835,37694,32593,29302,26760,30437,35862,31280,39363,54623,42079,41513,42804,46834,74454,81744,81535,123009,100782,93489,85065,68328,60862,54076,55404,50705,54565,57460,59781,51124,40369,41733,43158,48334,49495,40740,38611,37276,36665,41163,40906,42951,44594,39936,38834,39088,40843,37936,37959,36143,31831,30652],
  "BNKR": [12,12,10,10,10,10,10,9,9,9,9,9,9,9,9,8,8,8,8,7,8,8,8,9,9,9,10,9,9,9,9,9,8,9,8,9,8,8,8,8,8,8,8,8,8,8,8,8,8,9,9,9,8,8,8,8,11,10,13,15,16,14,13,14,12,12,13,14,12,13,13,13,15,19,16,16,13,15,13,14,13,13,12,11,11,12,12,12,12,12,12,11,11,12,12,11,11,10,9],
  "SP500": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,4505,4506,4475,4476,4509,4491,4512,4505,4533,4517,4527,4552,4527,4520,4575,4579,4579,4586,4580,4607,4661,4639,4690,4696,4674,4698,4687,4724,4753,4686,4681,4691,4699,4660,4690,4725,4728,4801,4766,4773,4764,4774,4797,4800,4807,4808,4811,4820,4798,4684,4683,4665,4697,4665,4595,4696,4722,4721,4749,4789,4767,4731,4757,4737,4746,4733,4727,4669,4683,4656],
};

const MONTHS: Record<string, number> = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

function labelToIso(label: string): string {
  const [mon, day] = label.split(" ");
  const m = MONTHS[mon!];
  if (!m) throw new Error(`wallet-history-seed: bad label ${label}`);
  return `2026-${String(m).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
}

export interface WalletHistorySeedRow {
  date: string; // ISO calendar day
  symbol: string;
  valueUsd: number;
}

// Flatten to (date, symbol, valueUsd) rows, skipping the 0 (not-held) slots so
// byAsset stays sparse. Order: date ascending, tracked-asset order.
export function walletHistorySeedRows(): WalletHistorySeedRow[] {
  const symbols = Object.keys(AUM);
  const rows: WalletHistorySeedRow[] = [];
  for (let i = 0; i < LABELS.length; i++) {
    const date = labelToIso(LABELS[i]!);
    for (const symbol of symbols) {
      const v = AUM[symbol]![i]!;
      if (v > 0) rows.push({ date, symbol, valueUsd: v });
    }
  }
  return rows;
}
