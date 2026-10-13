"""Fetch every input the allocation harness reads, from public sources, into one folder.

  python3 scripts/allocate-data.py --out data/

Writes:
  raw-indicator-history.csv  robotmoney.network public analytics API (date,indicator,value,source)
  prices-8y.csv              daily value index per backtest series, 2018-10-07..2026-10-07 (date,series,value)

The harness itself (bin/allocate.ts) never touches the network; this script is the
only fetch step. Yahoo and DefiLlama need no key. Rules for the dollar book match
the allocation reference page, appendix A2:
  - Aave chain: Aave v3 Base from 2024-03-10, Aave v3 Ethereum from 2023-02-06,
    Compound v3 Ethereum from 2022-10-06, Compound v2 Ethereum from 2022-02-11,
    the 3-month T-bill (DTB3) before that.
  - Morpho vaults from their DefiLlama start dates, the Aave chain before.
  - sUSDS from 2025-02-21, sDAI from 2022-12-04, 0.01% from 2022-10-06, the Aave
    chain before.
  - APY clipped to 0..30%, accrued daily on the previous day's rate.
  - USDC and DAI marked at market from 2022-01-01, at par before (Yahoo's earlier
    prints are noise).
"""
import argparse, csv, gzip, json, os, time, urllib.request, datetime as dt

UA = {"User-Agent": "Mozilla/5.0"}
START, END = "2018-10-07", "2026-10-07"


def get(url, tries=5, as_text=False):
    for a in range(tries):
        try:
            r = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90)
            b = r.read()
            return b if as_text else json.loads(b)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(int(e.headers.get("Retry-After", "10")))
                continue
            time.sleep(3 * (a + 1))
        except Exception:
            time.sleep(3 * (a + 1))
    raise RuntimeError(url)


def raw_history(out):
    rows, cursor, pages = [], None, 0
    while True:
        url = "https://robotmoney.network/api/public/analytics/raw-history?limit=1000" + (f"&cursor={cursor}" if cursor else "")
        d = get(url)
        rows += d["rows"]; pages += 1; cursor = d.get("nextCursor")
        if not cursor:
            break
        time.sleep(0.65)  # 100 requests a minute per ip
    with open(os.path.join(out, "raw-indicator-history.csv"), "w", newline="") as f:
        w = csv.writer(f); w.writerow(["date", "indicator", "value", "source"])
        for r in rows:
            w.writerow([r["date"], r["indicator"], r["value"], r.get("source") or "api"])
    return len(rows), pages


def yahoo(t, p1, p2, adj):
    j = get(f"https://query1.finance.yahoo.com/v8/finance/chart/{t}?period1={p1}&period2={p2}&interval=1d&events=div,splits")
    R = j["chart"]["result"][0]; ind = R["indicators"]
    ac = ind["adjclose"][0]["adjclose"] if (adj and ind.get("adjclose")) else ind["quote"][0]["close"]
    m = {}
    for x, v in zip(R["timestamp"], ac):
        if v is not None:
            m[dt.datetime.fromtimestamp(x, dt.timezone.utc).strftime("%Y-%m-%d")] = v
    time.sleep(0.4)
    return m


def prices(out):
    p1 = int(dt.datetime(2018, 9, 20, tzinfo=dt.timezone.utc).timestamp())
    p2 = int(dt.datetime(2026, 10, 9, tzinfo=dt.timezone.utc).timestamp())
    Y = {"GLD": yahoo("GLD", p1, p2, True), "BTC-USD": yahoo("BTC-USD", p1, p2, False),
         "USDC-USD": yahoo("USDC-USD", p1, p2, False), "DAI-USD": yahoo("DAI-USD", p1, p2, False)}
    for t in ["SPY", "TIP", "TLT", "IEFA", "IEMG", "BIL", "AAPL", "NVDA", "META", "GOOGL", "AMZN", "MSFT", "TSLA"]:
        Y[t] = yahoo(t, p1, p2, True)
    POOLS = dict(aave3e="aa70268e-4b52-42bf-a116-608b370f9501", aave3b="7e0661bf-8cf3-45e6-9424-31916d4c7b84",
                 comp3e="7da72d09-56ca-4ec5-a45f-59114353e487", comp3b="0c8567f8-ba5b-41ad-80de-00a71895eb19",
                 comp2e="cefa9bb8-c230-459a-a855-3b94e96acd8c",
                 susds="d8c4eff5-c8a9-46fc-a888-057c4c668e72", sdai="c8a24fee-ec00-4f38-86c0-9f6daebc4225",
                 gt="e0672197-9f3e-4414-bca5-e6b4c90aa469", spark="a5fab52f-73fa-4f44-9c09-9af1eb20996c",
                 steak="ba68527f-8ec2-4c55-827a-8f4673ae047c")
    C = {}
    for k, pid in POOLS.items():
        m = {}
        for d in get("https://yields.llama.fi/chart/" + pid)["data"]:
            m[d["timestamp"][:10]] = d["apyBase"] if d.get("apyBase") is not None else d["apy"]
        C[k] = m; time.sleep(0.4)
    # 3-month T-bill (DTB3, percent), from the regime engine's own extras fixture
    ex = get("https://raw.githubusercontent.com/robotmoney/robotmoney-frontend/main/backend/tests/fixtures/regime/regime-extras.json.gz", as_text=True)
    tb = {p["date"]: p["value"] for p in json.loads(gzip.decompress(ex))["tbill3m"]}

    d0, d1 = dt.date.fromisoformat(START), dt.date.fromisoformat(END)
    D = [(d0 + dt.timedelta(i)).isoformat() for i in range((d1 - d0).days + 1)]

    def ff(m):
        ks = sorted(m); out_, j, last = [], 0, None
        for d in D:
            while j < len(ks) and ks[j] <= d:
                last = m[ks[j]]; j += 1
            out_.append(last)
        return out_

    PX = {t: ff(Y[t]) for t in Y}; R = {k: ff(C[k]) for k in C}; TB = ff(tb)
    cap = lambda x: None if x is None else min(max(x, 0), 30)

    def chain(i, arr):
        for frm, k in arr:
            if D[i] >= frm and R[k][i] is not None:
                return cap(R[k][i])
        return None

    n = len(D)
    proxy = [cap(TB[i]) if TB[i] is not None else 0 for i in range(n)]
    aave = [chain(i, [("2024-03-10", "aave3b"), ("2023-02-06", "aave3e"), ("2022-10-06", "comp3e"), ("2022-02-11", "comp2e")]) for i in range(n)]
    rate = {"AAVE": [a if a is not None else proxy[i] for i, a in enumerate(aave)]}
    comp = [chain(i, [("2024-03-27", "comp3b"), ("2022-10-06", "comp3e"), ("2022-02-11", "comp2e")]) for i in range(n)]
    rate["COMP"] = [c if c is not None else rate["AAVE"][i] for i, c in enumerate(comp)]
    sus = [chain(i, [("2025-02-21", "susds"), ("2022-12-04", "sdai")]) for i in range(n)]
    rate["SUSDS"] = [s if s is not None else (0.01 if D[i] >= "2022-10-06" else rate["AAVE"][i]) for i, s in enumerate(sus)]
    for k, frm in [("GT", "2024-06-18"), ("SPARK", "2025-01-15"), ("STEAK", "2025-12-02")]:
        key = k.lower()
        rate[k] = [cap(R[key][i]) if D[i] >= frm and R[key][i] is not None else rate["AAVE"][i] for i in range(n)]
    usdc = [PX["USDC-USD"][i] if D[i] >= "2022-01-01" and PX["USDC-USD"][i] else 1.0 for i in range(n)]
    dai = [PX["DAI-USD"][i] if D[i] >= "2022-01-01" and PX["DAI-USD"][i] else 1.0 for i in range(n)]
    IDX = {}
    for k in ["AAVE", "COMP", "SUSDS", "GT", "SPARK", "STEAK"]:
        u, o = 1.0, []
        for i in range(n):
            if i:
                u *= 1 + rate[k][i - 1] / 100 / 365
            o.append(u * (dai[i] if k == "SUSDS" else usdc[i]))
        IDX[k] = o
    IDX["USDC"] = usdc; IDX["GOLD"] = PX["GLD"]; IDX["BTC"] = PX["BTC-USD"]
    for t in ["SPY", "TIP", "TLT", "IEFA", "IEMG", "BIL", "AAPL", "NVDA", "META", "GOOGL", "AMZN", "MSFT", "TSLA"]:
        IDX[t] = PX[t]
    # APY per yield sleeve (percent), for the engine's within-sleeve allocation
    for k in ["AAVE", "COMP", "SUSDS", "GT", "SPARK", "STEAK"]:
        IDX["APY_" + k] = rate[k]
    with open(os.path.join(out, "prices-8y.csv"), "w", newline="") as f:
        w = csv.writer(f); w.writerow(["date", "series", "value"])
        for k, arr in IDX.items():
            for i in range(n):
                w.writerow([D[i], k, repr(arr[i])])
    return n, list(IDX)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--out", default="data"); ap.add_argument("--skip-raw", action="store_true")
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
    if not a.skip_raw:
        print("raw history:", raw_history(a.out))
    print("prices:", prices(a.out))
