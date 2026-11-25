// Issue 1734 (D94): the backtest no longer reproduces the original JS reference
// number for number (a label trades one session later, closed markets defer a
// trade, Sharpe is post-cost and net of cash, the cash leg is a yield). What the
// original still fixes is the shape: portfolios, strategies and report fields.
// shapeDiffs lists where `got` lacks a key or a kind of value the original has.
// `got` may carry more keys (the labelled sample blocks).
export function shapeDiffs(got: unknown, expected: unknown, path = "$"): string[] {
  if (expected === null || typeof expected === "number") {
    return got === null || typeof got === "number" ? [] : [`${path}: expected a number or null, got ${JSON.stringify(got)}`];
  }
  if (typeof expected === "string") return typeof got === "string" ? [] : [`${path}: expected a string`];
  if (typeof expected === "boolean") return typeof got === "boolean" ? [] : [`${path}: expected a boolean`];
  if (Array.isArray(expected)) return Array.isArray(got) ? [] : [`${path}: expected an array`];
  if (typeof expected === "object") {
    if (got === null || typeof got !== "object" || Array.isArray(got)) return [`${path}: expected an object`];
    const out: string[] = [];
    for (const k of Object.keys(expected as object)) {
      if (!(k in (got as object))) out.push(`${path}.${k}: missing`);
      else out.push(...shapeDiffs((got as Record<string, unknown>)[k], (expected as Record<string, unknown>)[k], `${path}.${k}`));
    }
    return out;
  }
  return [];
}
