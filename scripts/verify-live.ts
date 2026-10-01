// `bun run verify:live` — the product verification pass, as a SEPARATE PROCESS
// from the deployment.
//
// `bun smoke` deploys: it restores, migrates, builds, boots, and declares itself
// live. What it must not also be is the thing that decides whether the product
// is correct — today that judgement lives inside smoke-main.ts behind
// `if (process.env.CI && !smokeMode)`, which means a standing boot and a
// production cutover run none of it, and the release's postflight grew a second
// and much weaker code path that only asserts migrations landed.
//
// This script is that judgement, extracted: it attaches to an ALREADY-LIVE
// stack over HTTP, asserts product invariants, reports in the repo's standard
// check format, and emits the same receipt JSON the rollout tooling reads.
//
// USAGE
//   bun run scripts/verify-live.ts                       # resolve from the instance's stack record
//   bun run scripts/verify-live.ts --instance <name>     # …of that instance (spec §1.1)
//   bun run scripts/verify-live.ts --base http://host:port
//   bun run scripts/verify-live.ts --tier full           # twin/CI only (see below)
//   bun run scripts/verify-live.ts --emit-receipt=P8.verify-prod
//
// TIERS, and why they are not a nicety. A `readonly` leg issues GETs; a `full`
// leg DRIVES the product — publishes sessions, spends inference, sends mail.
// Running a `full` leg against production would manufacture exactly the history
// the readonly legs exist to audit. `readonly` is the default for that reason:
// the destructive direction must be the one you have to ask for.
//
// EXIT CODES match the upgrade scripts' contract, because a receipt consumer
// must be able to tell these apart:
//   0 — every check passed
//   1 — at least one check FAILED (the product is wrong)
//   2 — could not run (the stack never came live; nothing was asserted)
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runVerification, type VerifyTier } from "./lib/verify/harness.ts";
import { swarmPipelineLeg } from "./lib/verify/legs/swarm-pipeline.ts";
import { twinRosterLeg } from "./lib/verify/legs/twin-roster.ts";
import { judgeReceiptLeg } from "./lib/verify/legs/judge-receipt.ts";
import { instanceFlag, readStackState, selectExistingInstance, stateRoot } from "./lib/smoke-state.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every leg, in the order a failure is most usefully read. */
// twinRosterLeg is `full`-tier, so it runs on a twin/CI target and never
// against production, where an absent member is honest rather than a defect.
const LEGS = [swarmPipelineLeg, twinRosterLeg, judgeReceiptLeg];

/** Default budget. Live upstreams are eventually consistent right after a boot
 *  (smoke-live-smoke.ts's reasoning), so the legs poll rather than read once. */
const DEFAULT_DEADLINE_MS = 5 * 60 * 1000;

function arg(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/**
 * Resolve the origin that serves PAGES and the API.
 *
 * webPort, NOT apiPort (issue #892): website-server is the static/SPA origin,
 * and the api answers /views/* with the SPA shell. The stage rehearsal shipped
 * that exact bug — ~40 content assertions missed and read like a broken
 * frontend. BACKEND_URL wins when set, because CI already exports it.
 */
function resolveBase(): { base: string; how: string } | { error: string } {
  const explicit = arg("--base") ?? process.env.VERIFY_BASE_URL ?? process.env.BACKEND_URL;
  if (explicit) return { base: explicit.replace(/\/$/, ""), how: "explicit" };

  // The instance's stack record (spec §1.1: state lives in the instance's
  // directory, never the checkout), selected by `--instance` or as the only
  // instance with state on this host.
  try {
    const paths = selectExistingInstance(stateRoot(process.env), instanceFlag(process.argv.slice(2)));
    const state = readStackState(paths);
    if (state === null) {
      return { error: `no --base given and ${paths.stackStateFile} does not exist. Pass --base http://host:port, or run this after a smoke boot of that instance.` };
    }
    if (!state.webPort) {
      return { error: `${paths.stackStateFile} has no webPort — the boot never reached its ports. Pass --base explicitly.` };
    }
    return { base: `http://127.0.0.1:${state.webPort}`, how: `instance ${state.instance ?? "?"} stack record (project=${state.project})` };
  } catch (e) {
    return { error: `no --base given, and no instance stack record to read one from: ${e instanceof Error ? e.message : String(e)}` };
  }
}

const tierArg = (arg("--tier") ?? "readonly") as VerifyTier;
if (tierArg !== "readonly" && tierArg !== "full") {
  console.error(`[verify-live] unknown --tier "${tierArg}" (expected: readonly | full)`);
  process.exit(2);
}

const resolved = resolveBase();
if ("error" in resolved) {
  console.error(`[verify-live] ${resolved.error}`);
  process.exit(2);
}

const receiptStep = process.argv.find((a) => a.startsWith("--emit-receipt="))?.split("=", 2)[1]
  ?? (process.argv.includes("--emit-receipt") ? "P8.verify-live" : undefined);

console.log(`[verify-live] base resolved from ${resolved.how}`);

const exit = await runVerification({
  name: "verify-live",
  base: resolved.base,
  tier: tierArg,
  legs: LEGS,
  deadlineMs: Number(arg("--deadline-ms") ?? process.env.VERIFY_DEADLINE_MS ?? DEFAULT_DEADLINE_MS),
  repoRoot,
  receiptStep,
  // The verification is release-neutral, so it borrows the release-agnostic
  // glob rather than importing a versioned steps.ts — a receipt records which
  // tag HEAD carried, and `v*` answers that for any release.
  tagGlob: "v*",
  hostRole: process.env.VERIFY_HOST_ROLE ?? "stage",
});
process.exitCode = exit;
