// The CLI side of the universe check (issue 1400): `--universe <path>` and
// `--allow-outside-universe`. The `universe:check` command (bin/check-universe.ts)
// calls universeFromArgs, then universeGate on the holdings by state,
// and exits with the gate's code. The file read lives here, in bin/,
// because src/ may not touch the filesystem.
import { checkHoldings, loadUniverse, type HoldingFinding, type HoldingsByState, type Universe } from "../src/allocate/universe.ts";

export const UNIVERSE_FLAG = "--universe";
export const ALLOW_OUTSIDE_FLAG = "--allow-outside-universe";

/** The universe named by `--universe <path>`, or the shipped one. A missing path is a RangeError (a usage error, exit 2). */
export async function universeFromArgs(args: readonly string[]): Promise<Universe> {
  const i = args.indexOf(UNIVERSE_FLAG);
  if (i < 0) return loadUniverse();
  const path = args[i + 1];
  if (path === undefined || path.startsWith("--")) throw new RangeError(`${UNIVERSE_FLAG} needs a path`);
  return loadUniverse(JSON.parse(await Bun.file(path).text()));
}

export interface UniverseGateResult {
  /** 2 when there are findings and `--allow-outside-universe` is not set; otherwise 0. */
  exitCode: 0 | 2;
  findings: HoldingFinding[];
  /** One line per finding, for stderr. */
  lines: string[];
}

/** Refuse holdings with findings unless `--allow-outside-universe` is set. */
export function universeGate(holdingsByState: HoldingsByState, universe: Universe, args: readonly string[]): UniverseGateResult {
  const findings = checkHoldings(holdingsByState, universe);
  const allowed = args.includes(ALLOW_OUTSIDE_FLAG);
  const prefix = allowed ? "warning (allowed by --allow-outside-universe)" : "refused";
  const lines = findings.map((f) => `${prefix}: ${f.message}`);
  return { exitCode: findings.length && !allowed ? 2 : 0, findings, lines };
}
