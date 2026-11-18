#!/usr/bin/env bun
// scripts/release/coingecko-credit.ts — the paid CoinGecko account has credit
// left this month (issue 1664), run ON THE PRODUCTION HOST by the template step
// P09-coingecko-credit (preflight, production only: stage holds no key).
//
//   bun scripts/release/coingecko-credit.ts [--env-file <path>]
//
// WHY. CoinGecko counts credit per account, and on 2026-11-16 the monthly
// credit ran out: every paid call answered HTTP 429 error_code 10006 until the
// month reset, and nothing said so for two days. The backend now fails over to
// the free hosts on that refusal, but a release should not start on an account
// already near empty. This check reads GET /key once (it reports the account's
// usage) and goes red when the remaining credit is below the floor.
//
// The key comes from COINGECKO_API_KEY, else from the host's ~/.env (the file
// compose reads it from). It only ever lands in the request header; nothing
// printed here carries it.
//
// Exit 0: remaining >= COINGECKO_CREDIT_FLOOR_PCT (default 10) percent of the
// monthly credit. Exit 1: below the floor, or /key failed or answered something
// unreadable. Exit 2: no key.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnvFile } from "../lib/env-role.ts";

export const KEY_URL = "https://pro-api.coingecko.com/api/v3/key";
export const DEFAULT_FLOOR_PCT = 10;

export interface CreditDeps {
  readonly key: string | undefined;
  readonly floorPct?: number;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly out?: (line: string) => void;
  readonly err?: (line: string) => void;
}

/** The floor from COINGECKO_CREDIT_FLOOR_PCT, else the default. A value outside 0..100 is the default. */
export function floorPctFromEnv(raw: string | undefined = process.env.COINGECKO_CREDIT_FLOOR_PCT): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_FLOOR_PCT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : DEFAULT_FLOOR_PCT;
}

/** Read the account's usage and judge it against the floor. Returns the exit code. */
export async function checkCoingeckoCredit(deps: CreditDeps): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const key = (deps.key ?? "").trim();
  const redact = (s: string) => (key ? s.split(key).join("[REDACTED]") : s);
  if (!key) {
    err("[coingecko-credit] REFUSE: no COINGECKO_API_KEY in the environment or ~/.env; production holds the paid key");
    return 2;
  }
  const floorPct = deps.floorPct ?? DEFAULT_FLOOR_PCT;
  const doFetch = deps.fetch ?? ((url: string, init: RequestInit) => fetch(url, init));
  let res: Response;
  try {
    res = await doFetch(KEY_URL, { headers: { accept: "application/json", "x-cg-pro-api-key": key }, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    err(redact(`[coingecko-credit] REFUSE: GET /key failed: ${(e as Error).message}`));
    return 1;
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    err(redact(`[coingecko-credit] REFUSE: GET /key answered HTTP ${res.status}: ${text.slice(0, 300)}`));
    return 1;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    err("[coingecko-credit] REFUSE: GET /key answered a body that is not JSON");
    return 1;
  }
  const monthly = Number(body.monthly_call_credit);
  const used = Number(body.current_total_monthly_calls);
  const remaining = Number(body.current_remaining_monthly_calls);
  if (![monthly, used, remaining].every(Number.isFinite) || monthly <= 0) {
    err("[coingecko-credit] REFUSE: GET /key did not report monthly_call_credit, current_total_monthly_calls and current_remaining_monthly_calls");
    return 1;
  }
  const floor = Math.ceil((monthly * floorPct) / 100);
  out(redact(`[coingecko-credit] plan ${String(body.plan ?? "?")}: used ${used}, remaining ${remaining}, monthly credit ${monthly} (floor ${floorPct}% = ${floor})`));
  if (remaining < floor) {
    err(`[coingecko-credit] REFUSE: remaining credit ${remaining} is below the floor ${floor} (${floorPct}% of ${monthly})`);
    return 1;
  }
  out("[coingecko-credit] ok");
  return 0;
}

/** The key from the environment, else from the env file (default ~/.env). */
export function resolveKey(envFile: string, env: Record<string, string | undefined> = process.env): string | undefined {
  if ((env.COINGECKO_API_KEY ?? "").trim()) return env.COINGECKO_API_KEY;
  if (!existsSync(envFile)) return undefined;
  return parseEnvFile(readFileSync(envFile, "utf8")).COINGECKO_API_KEY;
}

async function main(argv: string[]): Promise<number> {
  const i = argv.indexOf("--env-file");
  const envFile = i >= 0 && argv[i + 1] ? argv[i + 1]! : join(homedir(), ".env");
  return checkCoingeckoCredit({ key: resolveKey(envFile), floorPct: floorPctFromEnv() });
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
