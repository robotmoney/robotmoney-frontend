// Canonical committee-application payload — part of the protocol, so it lives
// in the contract and is shared by the backend (verify), the frontend
// `/committee/apply` page, the docs, and the `rmpc` Rust signer (golden
// vectors in `./__fixtures__/committee-application.json`). Deterministic:
// fixed key order + JSON.stringify, so every party produces identical bytes —
// same discipline as `canonicalizeSubmission` in `./signing.js`.
//
// docs/decisions.md D21 retired the MCP server: onboarding is REST-only, and
// the `committee-onboarding` skill (robotmoney-core) — not a live MCP tool —
// is the discovery mechanism (§11 R5). `mcp/`'s `apply-how-to`/`apply` tools
// still import ONBOARDING_PROMPT/APPLY_HOW_TO_STEPS below as of this commit
// only because `mcp/`'s own retirement is separate follow-up work (tracked
// issue); this file's content already reflects the REST-only target.
//
// Field set per docs/architecture.md §11 R6: {name, contact, lens?, publicKey}.
// `lens` is genuinely optional (not every applicant states one), so — unlike
// `canonicalizeSubmission`'s `body`/`memoUrl` which default to `""` — it is
// omitted from the canonical bytes entirely when absent, the same way
// `canonicalizeSubmission` treats `weights`. This keeps the signed payload
// byte-identical to what an application without a lens would produce, so a
// signature made before a lens is added never silently changes meaning.
/**
 * @param {{ name: string, contact: string, lens?: string, publicKey: string }} a
 * @returns {string}
 */
export function canonicalizeApplication(a) {
  const ordered = {
    name: a.name,
    contact: a.contact,
    ...(a.lens != null ? { lens: a.lens } : {}),
    publicKey: a.publicKey,
  };
  return JSON.stringify(ordered);
}

// The single copy-paste prompt an owner drops into their agent harness (R4).
// It never goes stale because it only ever points at installing the
// `committee-onboarding` skill (R5) — maintained centrally in robotmoney-core
// and fetched fresh on each install — rather than embedding the step list
// itself. `<display name>` and `<email>` are literal placeholders the owner
// fills in by hand before pasting — matching the existing docs convention
// (frontend/public/views/docs/investment-committee/participation.html,
// runbook.html) so this constant can replace those inline copies verbatim.
export const ONBOARDING_PROMPT =
  "We are setting up Robot Money tooling so you can participate in a long-running task: writing investment memos and presenting them to an investment committee. " +
  "First, install the \"committee-onboarding\" skill from https://github.com/robotmoney/robotmoney-core — it walks you through installing the rmpc message-signing client, generating your signing key, and applying to the Investment Committee over the REST API. " +
  "In short: (a) install the rmpc message-signing client and generate your signing key; " +
  "(b) submit the signed application — I am <display name>, contact <email>; it must be signed with your key, so it only completes if your setup actually works; " +
  "(c) wait to be accepted; " +
  "(d) once accepted, read the financial data from the research engine each session and write your recommendations.";

// Tracked: robotmoney/robotmoney-core issue to rewrite SKILL.md for D21
// (REST-only, skill-install-first) — filed alongside this commit. This is
// the placeholder the plan calls for so the onboarding prompt, the demo, and
// docs all point at ONE constant instead of duplicating the URL, and
// swapping it later is a one-line change here.
export const COMMITTEE_ONBOARDING_SKILL_URL =
  "https://raw.githubusercontent.com/robotmoney/robotmoney-core/main/plugins/robotmoney-committee/skills/committee-onboarding/SKILL.md";

// The canonical, current statement of application steps (§11.2 R5). Under
// D21 there is no live tool serving this — the skill itself (linked above)
// is the discovery mechanism — but this remains the single source docs/tests
// snapshot against instead of hand-copying prose, and (until mcp/'s own
// retirement, tracked separately) is still what mcp/src/server.ts's
// `apply-how-to` tool returns verbatim. `step` is a stable machine-readable
// slug (matches the §11.2 sequence names); `summary` is the human-readable
// instruction.
export const APPLY_HOW_TO_STEPS = [
  {
    step: "toolchain",
    summary:
      "Install the rmpc message-signing client from robotmoney-core (see the linked skill) and use it to generate an ed25519 identity locally. " +
      "Robot Money never generates or sees a private key.",
  },
  {
    step: "apply",
    summary:
      "Submit the signed application: your name, contact, an optional lens, your public key, and an rmpc signature over the canonical application payload, to POST /api/committee/apply — the only channel. " +
      "The public API and web form accept the same signed payload. " +
      "An unsigned or badly-signed submission is rejected and nothing is recorded.",
  },
  {
    step: "review",
    summary:
      "Wait for a human admin to approve the application. (In `bun run demo`, approval is automatic ~10 seconds later, through the same admin API.)",
  },
  {
    step: "claim",
    summary:
      "Once approved, claim your bearer token by signing the server's challenge, then participate over the REST API with member credentials.",
  },
];
