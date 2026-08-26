// Standing-smoke newcomer roster (fixed, finite — never generated). Split out
// of smoke-main.ts, mirroring smoke-env.ts's split for resolveSmokeEnv, so this
// pure logic is importable from tests without triggering smoke-main.ts's
// module-load side effects (port allocation, log files, docker compose).
//
// The smoke's periodic onboarding driver admits EXACTLY these named
// newcomers, in order, and never more — no generated fallback name once the
// list is exhausted (previously it fell through to `Astra ${n+1}` forever).
export const NEWCOMER_NAMES = ["Helios", "Selene", "Rhea", "Nyx", "Eos"];
export const NEWCOMER_LENSES = ["liquidity", "volatility", "credit", "tail risk", "sentiment", "flows", "macro", "positioning"];

export interface PlannedNewcomer {
  memberId: string;
  name: string;
  lens: string;
  bias: number;
}

// Deterministic name/lens/bias for the n-th admission — shared by the driver
// and the upcoming-queue preview so the TUI shows exactly who joins next.
// null once the fixed list is exhausted — callers must stop, never fall back
// to a generated name.
export function plannedNewcomer(n: number): PlannedNewcomer | null {
  const name = NEWCOMER_NAMES[n];
  if (!name) return null;
  return {
    memberId: name.toLowerCase().replace(/\s+/g, "-"),
    name,
    lens: NEWCOMER_LENSES[n % NEWCOMER_LENSES.length],
    bias: ((n % 5) - 2) * 0.05, // spread -0.10 … +0.10
  };
}
