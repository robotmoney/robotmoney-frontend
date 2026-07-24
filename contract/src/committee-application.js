// Canonical committee-application payload — part of the protocol, so it lives
// in the contract and is shared by the backend (verify), the MCP server
// (`apply-how-to` / `apply` tools), the frontend `/committee/apply` page, the
// docs, and the `rmpc` Rust signer (golden vectors in
// `./__fixtures__/committee-application.json`). Deterministic: fixed key
// order + JSON.stringify, so every party produces identical bytes — same
// discipline as `canonicalizeSubmission` in `./signing.js`.
//
// Field set per docs/architecture.md §11 R6: {name, contact, lens?, publicKey}.
// `lens` is genuinely optional (not every applicant states one), so — unlike
// `canonicalizeSubmission`'s `body`/`memoUrl` which default to `""` — it is
// omitted from the canonical bytes entirely when absent, the same way
// `canonicalizeSubmission` treats `weights`. This keeps the signed payload
// byte-identical to what an application without a lens would produce, so a
// signature made before a lens is added never silently changes meaning.
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
// It never goes stale because it only ever points at live discovery
// (`apply-how-to`) rather than embedding the step list itself. `<display
// name>` and `<email>` are literal placeholders the owner fills in by hand
// before pasting — matching the existing docs convention
// (frontend/public/views/docs/investment-committee/participation.html,
// runbook.html) so this constant can replace those inline copies verbatim.
export const ONBOARDING_PROMPT =
  "We are setting up Robot Money tooling so you can participate in a long-running task: writing investment memos and presenting them to an investment committee. " +
  "First, get access to the Robot Money MCP server — setup instructions: https://robotmoney.net/docs/investment-committee/participation#mcp. " +
  "Then ask the MCP server's \"apply-how-to\" tool for the current steps to apply to the Investment Committee. " +
  "In short: (a) install the rmpc message-signing client and generate your signing key; " +
  "(b) submit the signed application — I am <display name>, contact <email>; it must be signed with your key, so it only completes if your setup actually works; " +
  "(c) wait to be accepted; " +
  "(d) once accepted, read the financial data from the research engine each session and write your recommendations.";

// Out of scope for this session (staging `mcp.` subdomain + robotmoney-core
// SKILL.md, robotmoney/robotmoney-core#1170, are separate cross-repo work) —
// this is the placeholder the plan calls for so `apply-how-to` (Stage 2), the
// demo, and docs all point at ONE constant instead of duplicating the URL,
// and swapping it later is a one-line change here.
export const COMMITTEE_ONBOARDING_SKILL_URL =
  "https://raw.githubusercontent.com/robotmoney/robotmoney-core/main/plugins/robotmoney-committee/skills/committee-onboarding/SKILL.md";

// The canonical, current statement of application steps (§11.2 R5) — served
// by the MCP `apply-how-to` tool, and the single source docs/tests snapshot
// against instead of hand-copying prose. `step` is a stable machine-readable
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
      "Submit the signed application: your name, contact, an optional lens, your public key, and an rmpc signature over the canonical application payload. " +
      "Prefer this MCP server's `apply` tool — submitting over MCP simultaneously proves the connection works. The public API and web form accept the same signed payload. " +
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
      "Once approved, claim your bearer token by signing the server's challenge, then connect over MCP with member credentials to participate.",
  },
];
