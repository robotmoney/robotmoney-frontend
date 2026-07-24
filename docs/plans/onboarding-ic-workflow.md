# Plan: align tools, tests, and demos to the §11 onboarding workflow

Status: working plan (adhoc branch). Target: `docs/architecture.md` §11 (normative,
merged in #252) — sequence `connect → discover → apply → toolchain + keygen →
prove-setup → review/approve → claim + participate`, requirements R1–R8.
Companion issue for the skill this flow links: robotmoney/robotmoney-core#1170.

Current-state audit (2026-07-24, main @ `3ec7885`) found the claim flow (#205) and
activation email already §11-shaped; everything else diverges. The work splits into
six phases, ordered by dependency. Phases 1–2 are the contract; 3–5 make R8
(no-mock isomorphism) true; 6 is provisioning.

## Phase 1 — Apply contract: server-minted UUID, identity-only

Today `POST /api/committee/apply` requires a **client-supplied `memberId` and
`publicKey`** (`backend/src/api/routes/committee.ts:148`,
`backend/src/api/validation.ts:53`); `applyMember` stores an inactive key at apply
(`backend/src/committee/domain.ts:397`). §11 R1/R2 make apply identity-only
(`name`, `contact`) with the **server minting a random UUID** and returning it; no
key material until prove-setup.

- Change `applyMember` + route: accept `{name, contact, lens?}`, generate
  `memberId = randomUUID()`, return it in the 201 body. Drop the
  key-at-apply write; the `committee_member_keys` row is created at prove-setup
  (Phase 2). Keep the audit row and application `pending` status.
- Migration/compat: decide whether to keep accepting a client `memberId`
  temporarily (deprecation window for the old apply form + old tests) or cut over
  in one release. Recommendation: cut over — nothing in production depends on the
  old shape yet; the demo and tests are updated in the same change.
- Frontend apply form (`frontend/public/views/committee/apply.html`,
  `apply-form.js`): remove the member-id and keypair inputs and in-browser keygen;
  submit identity only; render the returned UUID prominently (it goes into the
  copy-paste prompt) with copy affordance.
- Rewrite affected tests, which assert the old contract:
  `backend/tests/committee.test.ts:27-52`,
  `backend/tests/committee-claim.test.ts:25-38` (its `applyAndActivate` helper),
  roster-cap tests that apply with explicit ids.

## Phase 2 — Prove-setup endpoint + gated review

Absent today (confirmed: no route accepts a public key + signed UUID pre-review).
§11 R6: before review, the agent submits the public key together with the
applicant UUID **signed via `rmpc`**; headless.

- New public route, e.g. `POST /api/committee/apply/prove-setup`
  (`{memberId, publicKey, signature}` where signature is ed25519 over the
  canonical UUID string). Verify with the same primitives as
  `claimMemberToken` (`domain.ts:503`); on success store the key row
  (`active=false`, no token) and flip the application to `setup_proven`.
- Admin review queue (`/api/committee/admin/applications`) surfaces setup-proof
  state; `activateMember` requires `setup_proven` (production rule; demo hits the
  same rule).
- Status page (promised by the runbook, absent today): public
  `GET /api/committee/apply/:id` returning redacted application state
  (`applied → setup_proven → approved → claimed`), plus a frontend view at
  `/committee/apply/:id` that polls it. Add both to `contract/src/routes.js`.
- Tests: new backend integration tests for prove-setup (valid/invalid signature,
  wrong UUID, replay, activation gated on proof), status-route redaction, and the
  end-to-end apply → prove → activate → claim chain.

## Phase 3 — MCP: public `apply-how-to` discovery tool

The MCP server has **no unauthenticated tool surface** — every session requires a
bearer before `buildServer` registers tools (`mcp/src/server.ts:312-333`). §11 R5
requires `apply-how-to` to answer **before any credentials exist**.

- Split session bootstrap: an unauthenticated `/mcp` session that exposes exactly
  the discovery toolset (`apply-how-to`, and nothing else), with the full member
  toolset still requiring OAuth as today. Simplest shape: build a second,
  anonymous `McpServer` instance when no bearer is presented instead of rejecting
  at `server.ts:312`.
- `apply-how-to` returns the canonical current steps (mirrors §11.2), the apply
  route and request shape, the prove-setup route, and the raw-GitHub link to the
  `committee-onboarding` skill in robotmoney-core. Source the content from one
  place (contract or a shared doc constant) so docs, tool, and tests can't drift.
- Tests: MCP test asserting `apply-how-to` is callable with no token; asserting
  every other tool still refuses anonymously; content snapshot test pinned to the
  §11 step names.

## Phase 4 — Demo isomorphism: rmpc keygen, new step names, 10 s auto-approve

Today `onboardMember()` (`mcp/src/e2e.ts:236-305`) does JS keygen
(`mcp/src/crypto.ts`), applies with a client id + key, sleeps ~4 s, activates,
claims, connects — and the TUI strip shows
`keypair → apply → review → activate → connect → session → memo → admitted`
(`scripts/lib/demo-main.ts:317`). §11 R8 requires the demo to drive the **real**
path: rmpc keygen, prove-setup, 10 s auto-approve through the same admin API.

- Rework `onboardMember()` to the §11 sequence: apply (identity-only, capture
  server UUID) → rmpc `committee-identity create` + `show-public-key` →
  prove-setup with rmpc `sign` over the UUID → 10 s wait → `admin/activate` →
  claim → MCP connect. Reuse the download/pin machinery from
  `scripts/rmpc-release-e2e.ts:93-123` so the demo shells out to the released
  binary; JS keygen remains only in unit tests of crypto primitives, not on the
  onboarding path.
- Rename `ONBOARD_STEPS` to track §11.2 (`connect`/`discover` prefix steps,
  `prove-setup` replaces `keypair`-before-apply ordering) and update the strip
  rendering + §10.1 of architecture.md to match.
- `discover` step: the demo calls the real `apply-how-to` tool (Phase 3) before
  applying, making the discovery path itself demo-proven.
- rmpc binary availability: demo downloads on first run and caches; the e2e/CI
  runner caches by release tag (same as the nightly). If robotmoney-core needs a
  new rmpc release for any subcommand gap, that lands first (cross-repo gate).

## Phase 5 — Test/CI adaptation

Per the test-coverage invariants: behaviour needs executed-in-CI assertions,
loud-skip only.

- `integration.yml` backend tests: Phases 1–2 rewrite the contract tests listed
  above; add prove-setup and status-route suites.
- `e2e.yml`: the demo gate (`bun run scripts/demo.ts`) now exercises rmpc +
  prove-setup on every PR — this pulls a network download of the rmpc release
  into the e2e job; cache it, and make absence **fail loudly** (no silent
  fallback to JS keygen — that would recreate the mock path R8 forbids).
- `rmpc-release-e2e-nightly.yml` / `scripts/rmpc-release-e2e.ts`: currently uses
  the pre-#205 activate-mints-credential assumption; update to
  apply → prove-setup → activate → claim → MCP, converging with Phase 4's
  driver (ideally the nightly and the demo share one driver module).
- Docs tests (`scripts/tests/committee-docs-rmpc-and-routes.test.ts`): extend to
  pin the copy-paste prompt's `apply-how-to` reference and the status-page route.

## Phase 6 — Deployment/provisioning (staging + demo MCP)

From the PR #252 deployment note: R8 needs a reachable MCP server everywhere.

- Demo: `mcp` container already in `docker-compose.demo.yml`; verify the
  anonymous discovery session works through it (Phase 3 test doubles as the
  check).
- Staging: provision `mcp.<staging-domain>` per the production topology (D18 /
  §3.1: orange-cloud proxied, alternate port 8443, `MCP_PORT=8443`, Cloud
  Firewall allowing 8443 from Cloudflare ranges). Until it exists the copy-paste
  prompt cannot be exercised against staging.

## Cross-repo dependencies (robotmoney-core)

- #1170/#1171: `committee-onboarding` SKILL.md — must match the Phase 1–3
  contract (identity-only apply, prove-setup shape, `apply-how-to` discovery).
  The frontend's `apply-how-to` response links it; land the contract here first,
  then finalize the skill text there.
- rmpc: confirm `committee-identity sign` over an arbitrary UUID payload works in
  the pinned release (v0.3.2 per `scripts/rmpc-release-e2e.ts:31`); if a newer
  release is needed, that gates Phase 4.

## Suggested issue slicing

One issue per phase (1–6), with Phase 1+2 optionally combined (they share the
contract migration and test rewrite). Phases 1–2 block 3–5; Phase 6 is parallel.
When promoted into the Plan, phases map to issues via `superfield-strategy`; this
document then retires in favor of the GitHub Plan tracking issue.
