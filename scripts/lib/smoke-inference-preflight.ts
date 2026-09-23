// THE STANDING STACK MUST REACH A FUNDED MODEL OR NOT BOOT (AC-MODEL-01).
//
// `bun run smoke:stage` — the `--static-port` boot a tunnel points at — IS the
// staging deployment. On 2026-09-13 it had been running for weeks on
// `AGENT_MODEL=free` (`nemotron-3-ultra-free`) with an EMPTY
// `OPENCODE_API_KEY`: every analyst take and every judgement it produced was
// unusable as evidence, and nothing anywhere said so. Two separate gaps made
// that possible, and this module closes both at the one point where the stack
// still has the chance to refuse to start.
//
//   1. THE CREDENTIAL NEVER REACHED THE BOOT. Only
//      scripts/lib/smoke-twin-rehearsal.ts read a key out of a file, and it
//      reads `.env.readonly` alone — deliberately, because that command family
//      is defined by not needing `.env`'s writer credential. `smoke:stage` has
//      the opposite constraint: it ALREADY reads `.env` (that is where it finds
//      DATABASE_URL), so `.env` is exactly where an operator correcting a stage
//      host puts the key. It was put there, and the boot could not see it.
//
//   2. THE MODEL WAS NEVER CHECKED. `resolveModelConfig()` accepted a keyless
//      model in silence — a free-tier model needs no credential, so the
//      "paid model with no key" refusal never fired.
//
// Resolution order for the credential is process environment, then `.env`, then
// `.env.readonly`; a boot with none of the three stops, naming all three.
//
// HOW THE RESOLVED VALUE ACTUALLY REACHES THE CONTAINERS, which is the whole
// point and which the first cut of this file got wrong. It is written back into
// the passed env (so the direct `docker compose` calls smoke-main.ts drives off
// `dockerEnv` see it) AND RETURNED as a compose-env fragment, because the api
// and worker-swarm services do NOT come up that way: they come up through
// `stack.up()`, whose child environment is `buildSpawnEnv()` — a fixed
// DOCKER_CLIENT_ENV_ALLOWLIST (PATH/HOME/DOCKER_*/proxy) plus
// `buildComposeEnv()`. That allowlist exists precisely to keep a provider secret
// out of a container (docs/architecture.md §11.3 E1), and it does its job: an
// OPENCODE_API_KEY in `process.env` is DROPPED there. So a key supplied in the
// process environment or in `./.env.readonly` used to pass this preflight,
// print its source, and leave the judge at `credential_unconfigured` for every
// session — only a key physically in `./.env` reached the containers, through
// docker compose's own env-file interpolation of
// docker-compose.yml's `${OPENCODE_API_KEY:-}`. The caller merges the returned
// fragment into `extraComposeEnv`, which is the one channel `buildComposeEnv()`
// emits, so all three sources now arrive at the two services that must have it
// (AC-MODEL-01: "it must reach every process that performs inference — analyst
// containers, the swarm worker, and the judge").
//
// Kept out of scripts/lib/smoke-main.ts because that file is under a line
// budget (scripts/tests/unit/smoke-main-split.test.ts) and because a refusal
// this consequential deserves its own tests — which are
// scripts/tests/unit/smoke-inference-preflight.test.ts (this module, driven
// against a fixture repo root and a plain env object, including the proof that
// the returned fragment reaches a real buildSpawnEnv()). The neighbouring
// scripts/tests/unit/ac-model-01-acceptance-inference.test.ts covers the two
// functions this one composes, resolveModelConfig() and resolveStackZenKey().
import { resolveModelConfig } from "./onboarding-eval.ts";
import { resolveStackZenKey, ZEN_KEY_ENV } from "./opencode-key.ts";

export interface InferencePreflightOptions {
  /** The `--static-port` boot: the standing/public stack, i.e. staging. */
  standingStack: boolean;
  repoRoot: string;
  /** Mutated in place on success — the stack's compose env is built from it. */
  env: Record<string, string | undefined>;
  log?: (m: string) => void;
}

/**
 * Resolve and install this boot's inference credential, then prove the model it
 * selects is one this environment may use. Throws on any refusal; the caller
 * turns that into a FATAL and a non-zero exit.
 *
 * RETURNS the compose-env fragment the caller must merge into
 * `extraComposeEnv` — `{ OPENCODE_API_KEY: … }` on a standing stack, and `{}`
 * everywhere else. See this file's header for why writing `process.env` is not
 * enough on its own.
 *
 * A NON-STANDING boot is left exactly as it was: the local `bun run smoke` and
 * CI paths keep every escape hatch D22 rule 1 as amended left open, including
 * `AGENT_MODEL=free` with no credential at all — including the fragment, which
 * stays empty so compose's own `./.env` interpolation keeps deciding, exactly as
 * it does today.
 */
export function preflightInference(opts: InferencePreflightOptions): Record<string, string> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const composeEnv: Record<string, string> = {};
  if (opts.standingStack) {
    const zen = resolveStackZenKey(opts.repoRoot, opts.env);
    if ("error" in zen) throw new Error(zen.error);
    // The VALUE is never printed — only which of the three places held it.
    log(`[smoke] inference credential: ${ZEN_KEY_ENV} from ${zen.source}`);
    opts.env[ZEN_KEY_ENV] = zen.key;
    composeEnv[ZEN_KEY_ENV] = zen.key;
  }
  // On the standing stack this refuses a keyless/free-family model and a raw-id
  // AGENT_MODEL override outright (D22 rule 1); everywhere else it is the
  // long-standing development resolution, unchanged.
  if (opts.standingStack || !opts.env.CI || opts.env.ONBOARDING_REAL_EVAL === "1") {
    resolveModelConfig(opts.env, { standingStack: opts.standingStack });
  }
  return composeEnv;
}

/**
 * preflightInference(), with the boot's own failure convention: name the
 * refusal as a FATAL and exit non-zero, exactly as smoke-main.ts's
 * stagePreflight() does for a held stage port. Kept here rather than at the
 * call site so the message an operator reads is written next to the rules that
 * produce it.
 */
export function preflightInferenceOrExit(opts: InferencePreflightOptions): Record<string, string> {
  try {
    return preflightInference(opts);
  } catch (err) {
    console.error(`[smoke] FATAL: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
