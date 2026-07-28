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
//   Stage  → `OPENCODE_API_KEY` in the standing demo host's .env
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

/** The env var the opencode CLI reads for the OpenCode Zen provider. */
export const ZEN_KEY_ENV = "OPENCODE_API_KEY";

/** The configured OpenCode Zen key, or null when none is set. */
export function zenApiKey(env: Record<string, string | undefined> = process.env): string | null {
  return env[ZEN_KEY_ENV]?.trim() || null;
}
