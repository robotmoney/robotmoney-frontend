// scripts/release/legacy-policy-env.ts — the one place a release script still
// names the retired `RM_ENV` (D69 part 4, issue 1327).
//
// Every operator tool of THIS checkout takes its §4.1 policy as `--policy
// prod|stage` and reads no environment value for it. Two release scripts run
// tools from a checkout that may be OLDER than this one:
//
//   - `bun run role-passwords` (./role-passwords.ts) runs `prod-init` from
//     whatever the target host has checked out, before R1.1 moves it;
//   - `stage-target up` (./stage-target.ts) builds the stage world from the
//     checkout production runs today.
//
// A tool from before issue 1327 reads its policy from `RM_ENV` (the process,
// else `~/.env`), and its `bun smoke` refuses `--policy` as an unknown flag. So
// these callers speak the checkout's language: the flag to a checkout that takes
// it, the legacy variable to one that does not. Nothing else in the release
// tooling names the variable. Delete this module once production runs a release
// whose tools take `--policy`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The retired policy variable a pre-1327 tool reads. Never read here. */
export const LEGACY_POLICY_ENV = "RM_ENV";

/** Whether a checkout's operator tools take `--policy`: its deploy-policy.ts exports the flag. */
export function checkoutTakesPolicyFlag(checkout: string): boolean {
  const file = join(checkout, "backend", "src", "deploy-policy.ts");
  return existsSync(file) && /^export const POLICY_FLAG\b/m.test(readFileSync(file, "utf8"));
}

/**
 * How to hand `policy` to a checkout's tools: argv to append for one that takes
 * the flag, an `env -i` pair for one that does not. PURE.
 */
export function policyForCheckout(takesFlag: boolean, policy: "prod" | "stage"): { readonly args: readonly string[]; readonly env: readonly string[] } {
  return takesFlag ? { args: ["--policy", policy], env: [] } : { args: [], env: [`${LEGACY_POLICY_ENV}=${policy}`] };
}
