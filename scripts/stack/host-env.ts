// The ONE deliberate, allowlisted read of the ambient environment on a stack
// path (docs/architecture.md §11.3 E1, docs/decisions.md D22 rule 1).
//
// scripts/stack/config.ts and scripts/stack/stack.ts never touch the process
// environment: every input arrives as an explicit argument, and `createStack`'s
// `hostEnv` defaults to EMPTY so a caller that forgets gets a hermetic child.
// But a compose child still has to be able to FIND a Docker daemon — PATH,
// DOCKER_HOST, DOCKER_CONTEXT, a proxy — and that plumbing genuinely lives in
// the ambient environment.
//
// This module supplies exactly that and provably nothing else: it filters
// through `DOCKER_CLIENT_ENV_ALLOWLIST`, so a provider key, an admin token, or
// a model-selection knob sitting in an operator's shell CANNOT come out of it
// (asserted in scripts/tests/unit/stack-config.test.ts against a deliberately
// polluted environment). That is what will let the keyless onboarding eval
// (D22 rule 1 — it may contain no environment read of its own at all) bring up
// a stack once it adopts this module.
//
// It is NOT a configuration surface: there is no branch here, no defaulting,
// and no eval-relevant variable on the allowlist to reach through.
import { DOCKER_CLIENT_ENV_ALLOWLIST } from "./config.ts";

export function dockerClientHostEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of DOCKER_CLIENT_ENV_ALLOWLIST) {
    const v = source[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}
