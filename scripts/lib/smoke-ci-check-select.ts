// Which of scripts/smoke-ci-checks.ts's checks to run (issue: e2e split by
// domain). Pure, so the selection rules are unit-tested without a stack.
//
//   (no --check)            every check, in CHECK_NAMES order; the onboarding
//                           sweep only when ONBOARDING_REAL_EVAL=1 (the
//                           original behaviour, kept for anyone running the
//                           whole file by hand).
//   --check a,b / --check a one or more named checks, in the order given. A
//                           named check ALWAYS runs: the e2e-onboarding
//                           workflow names `onboarding` on exactly the runs
//                           that asked for the eval, and a named check that
//                           silently did nothing would be a false green.
//
// An unknown name throws; it never selects nothing.

/** Every check, in the order a full run executes them. */
export const CHECK_NAMES = [
  "swarm-session",
  "starter-agent",
  "frontend",
  "browser",
  "live-smoke",
  "verify-live",
  "onboarding",
] as const;

export type CheckName = (typeof CHECK_NAMES)[number];

export function selectChecks(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): CheckName[] {
  const requested: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    let value: string | undefined;
    if (arg === "--check") {
      value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--check needs a value: one or more of " + CHECK_NAMES.join(", "));
      i++;
    } else if (arg.startsWith("--check=")) {
      value = arg.slice("--check=".length);
    }
    if (value !== undefined) requested.push(...value.split(",").map((v) => v.trim()).filter(Boolean));
  }

  if (requested.length === 0) {
    return CHECK_NAMES.filter((name) => name !== "onboarding" || env.ONBOARDING_REAL_EVAL === "1");
  }

  const known = new Set<string>(CHECK_NAMES);
  const unknown = requested.filter((name) => !known.has(name));
  if (unknown.length > 0) throw new Error(`unknown check${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} (known: ${CHECK_NAMES.join(", ")})`);
  return requested as CheckName[];
}
