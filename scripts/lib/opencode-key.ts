// The OpenCode Zen credential: one env var name, one meaning, everywhere.
//
// `OPENCODE_API_KEY` is not a name we chose — it is what the opencode CLI reads
// for the `opencode` (OpenCode Zen) provider, fixed by the provider definition
// on models.dev:
//   {"id":"opencode","env":["OPENCODE_API_KEY"],"api":"https://opencode.ai/zen/v1"}
// Using it directly means a configured key reaches every locally-spawned
// `opencode` process by plain environment inheritance — nothing to forward, and
// no second name to keep in sync.
//
// ── One name, different values per environment ─────────────────────────────
// The SAME variable carries a DIFFERENT key in each environment, so usage is
// attributable and one environment's spend or revocation never touches
// another's:
//   CI     → `secrets.OPENCODE_API_KEY` (GitHub Actions)
//   Stage  → `OPENCODE_API_KEY` in the standing smoke host's .env
//   Local  → `OPENCODE_API_KEY` in the developer's own .env
// Nothing in the code distinguishes them, and nothing should: the credential is
// environment-supplied by design. Rotating one is a secret change, never a
// code change.
//
// ── Credit is required ─────────────────────────────────────────────────────
// Zen bills the key from pay-as-you-go credit on its workspace. It is NOT
// covered by an opencode subscription plan (a "Go" plan funds the CLI/app, not
// this API key) — an unfunded key returns `CreditsError: Insufficient balance`
// on every paid model while still authenticating fine. The `free` model family
// in ./model-registry.ts is the unfunded escape hatch.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The env var the opencode CLI reads for the OpenCode Zen provider. */
export const ZEN_KEY_ENV = "OPENCODE_API_KEY";

/** The configured OpenCode Zen key, or null when none is set. */
export function zenApiKey(env: Record<string, string | undefined> = process.env): string | null {
  return env[ZEN_KEY_ENV]?.trim() || null;
}

// ── Where the STANDING stack finds it (AC-MODEL-01) ─────────────────────────
//
// `bun run smoke:stage` is the staging deployment, and until now the ONLY thing
// in this repo that read a credential out of a file was
// scripts/lib/smoke-twin-rehearsal.ts, which reads `.env.readonly` and
// deliberately refuses to read `.env` (that command family is defined by not
// needing the writer credential). The standing stack has the opposite
// constraint: `smoke:stage` already reads `.env` — that is how it finds
// DATABASE_URL — so a key sitting in the host's `.env` is exactly where an
// operator would reasonably put it, and on 2026-09-13 one was, while the
// running containers carried an empty `OPENCODE_API_KEY` baked in from a
// previous boot and every swarm judgement came back `model_unconfigured`.
//
// So: process environment, then `.env`, then `.env.readonly` — and when none of
// the three has it, a refusal that NAMES ALL THREE. A boot that cannot reach a
// funded model must not start and quietly produce evidence-shaped nothing.
export const ENV_FILE = ".env";
export const READONLY_ENV_FILE = ".env.readonly";

/** First `key=`/`key =` value in a dotenv-shaped file, or null. */
export function readDotenvKey(file: string, key: string): string | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null; // absent or unreadable is simply "not here"
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && m[1] === key) return m[2]!.trim().replace(/^["']|["']$/g, "") || null;
  }
  return null;
}

export type ZenCredential = { key: string; source: string } | { error: string };

/**
 * The funded OpenCode Zen credential for a stack boot, or a refusal that says
 * where to put it. PURE apart from reading the two files, so the unit tests
 * drive it against a fixture directory rather than a real checkout.
 */
export function resolveStackZenKey(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env,
): ZenCredential {
  const fromEnv = env[ZEN_KEY_ENV]?.trim();
  if (fromEnv) return { key: fromEnv, source: "process environment" };
  for (const file of [ENV_FILE, READONLY_ENV_FILE]) {
    const found = readDotenvKey(join(repoRoot, file), ZEN_KEY_ENV);
    if (found) return { key: found, source: `./${file}` };
  }
  return {
    error:
      `${ZEN_KEY_ENV} is not set, so this stack cannot reach a funded model. It is read from the ` +
      `process environment, then ./${ENV_FILE}, then ./${READONLY_ENV_FILE} — add it to one of them ` +
      "and boot again. Do NOT work around this with AGENT_MODEL=free: the keyless free family is " +
      "disqualified for acceptance (AC-MODEL-01), and a stack that publishes free-tier or " +
      "model_unconfigured judgements produces no evidence at all.",
  };
}
