# Demo Implementation Plan

How to evolve `bun run demo` from its current state to the full spec in
[`demo-spec.md`](./demo-spec.md). Each phase is independently mergeable and leaves
the demo in a working state.

---

## Phase 1 — Worker orchestration

**Goal:** Lifecycle transitions go through the real job queue, not direct domain calls.

Changes:
- `scripts/demo.ts` — add demo job seeds: enqueue `committee.open_session` instead
  of calling `openSession()` directly; enqueue the remaining lifecycle jobs
  sequentially after the previous one completes.
- `backend/src/worker/handlers/index.ts` — register `committee.*` handler map
  (already designed in ARCHITECTURE §9.4, may not be wired yet).
- `backend/src/worker/handlers/committee.ts` — new file. Each lifecycle job handler
  delegates to the corresponding `backend/src/committee/domain.ts` function.
- `backend/src/db/seed.ts` — ensure `committee.*` job schedules exist.
- Wait-for-job helpers in the demo script (poll `job_runs` or check session state)
  so the demo advances deterministically.

**Exit condition:** The demo's single session progresses
`scheduled → brief_published → collecting → window_closed → aggregated → published`
entirely through enqueued jobs claimed by the worker process.

---

## Phase 2 — Research signal pipeline in the demo

**Goal:** Research signals run alongside regime in the demo, and the brief includes
them.

Changes:
- `backend/src/analytics/index.ts` — the `Registry` should already register
  `channel-divergence` and `late-cycle`. Verify both execute when
  `analytics.run` fires.
- `mcp/src/e2e.ts` — after seeding regime, also seed at least one research signal
  snapshot (or run the full analytics suite for the demo date).
- `backend/src/committee/domain.ts` — `publishBrief()` must attach research signals
  to the brief (or make them independently readable).
- MCP `get_brief` — return research signal data alongside regime in the brief.

**Exit condition:** The demo seed writes into `research_signals`; the brief returned
by `get_brief` includes signal data; agents can read it.

---

## Phase 3 — agent memo (`post_memo` MCP tool)

**Goal:** At least one agent publishes a memo via MCP and includes the `memoUrl` in
its submission.

Changes:
- `mcp/src/server.ts` — add `post_memo` tool. The tool writes the memo payload to
  a configurable storage backend (for the demo, a simple in-memory or file-system
  store under `BACKEND_URL/memos/` served by a new static route).
- `backend/src/api/routes/committee.ts` — add `GET /api/committee/memos/:id` to
  serve stored memos (or proxy the MCP host).
- `contract/src/committee.d.ts` — verify `CommitteeSubmission.memoUrl` is typed
  correctly.
- `mcp/src/agent.ts` — after deciding stance but before `submit_recommendation`,
  call `post_memo` with a generated memo (e.g., "I'm bullish because…"). Store the
  returned URL and pass it as `memoUrl` in the submission.
- `mcp/src/e2e.ts` — assert the memo is retrievable at the returned URL and the
  signature covers the `memoUrl` (tampering test).

**Exit condition:** One agent (e.g., Athena) publishes a memo via `post_memo`,
submits a recommendation with the `memoUrl`, and the memo is publicly readable.

---

## Phase 4 — OAuth 2.1 on the MCP surface

**Goal:** Bearer tokens are replaced with a real OAuth 2.1 flow, exercised in the
demo.

Changes:
- `mcp/src/server.ts` — implement OAuth 2.1 authorization endpoint, token endpoint,
  and token introspection (or self-encoded JWTs). This is the heavy lift.
- `mcp/src/agent.ts` — replace bearer token with OAuth authorization code flow
  (or client credentials grant for server-to-server).
- `backend/src/lib/keys.ts` — keep access-key hashing as REST fallback for
  non-MCP clients; OAuth is for the MCP surface only.
- `RM_ALLOW_INSECURE=1` — keep for dev but the demo should exercise the OAuth path
  by default.
- `mcp/src/e2e.ts` — assert OAuth token exchange works and expired tokens are
  rejected.

**Risk:** Largest single piece of work. Could be split: first implement OAuth in
the MCP server, then wire the demo agents to use it.

**Exit condition:** Demo agents acquire tokens via OAuth 2.1, use them for MCP tool
calls, and expired/revoked tokens are rejected with the correct error.

---

## Phase 5 — Role authz / cross-role denial

**Goal:** Cross-role write denial is asserted in the demo.

Changes:
- `backend/migrations/0007_committee_rls_stub.sql` — implement the RLS policies
  (member can only write `committee_recommendations` with their own `member_id`;
  analytics provider can only write `regime_snapshots`; worker owns the session
  lifecycle tables).
- `mcp/src/e2e.ts` — add assertions:
  - An analytics-provider credential cannot call `submit_recommendation`.
  - A member credential cannot write regime data.
  - Neither can close/aggregate/publish a session.
- `backend/src/api/routes/committee.ts` — verify role gates are enforced at the
  handler level (defense-in-depth before RLS).

**Exit condition:** Three distinct credential types exist in the demo; every
cross-role write attempt returns 403, asserted in the E2E.

---

## Phase 6 — Frontend rendering assertions

**Goal:** The demo verifies that the published session renders correctly in the SPA.

Changes:
- Add a headless browser step (Playwright or `happy-dom` + fetch) to the demo
  after the session is published.
- Assertions:
  - `GET /committee` returns 200 and contains the session's subject name.
  - Signed takes show verification status (green check for valid, red X for absent).
  - Absent members are listed.
  - Regime chart container exists.
  - Research signal view for the seeded key exists.
  - `memoUrl` (if posted) renders as a link.
- This could be a separate script (`scripts/demo-frontend-check.ts`) called by
  `scripts/demo.ts` after the backend E2E completes.

**Exit condition:** The demo script runs headless assertions against the published
session's frontend and fails if renders are missing or incorrect.

---

## Phase 7 — Multi-session rotation

**Goal:** The demo runs two sessions back-to-back, demonstrating rotation awareness.

Changes:
- `mcp/src/e2e.ts` — after session N completes and publishes, start session N+1
  (same or different subject).
- Brief for N+1 references N's outcome (e.g., "last session was bullish on
  woon").
- `list_sessions` returns both.
- The frontend live view shows the multi-session history.

**Exit condition:** Two sessions complete the full lifecycle; the second session's
brief references the first.

---

## Phase 8 — Optional analysis MCP tools

**Goal:** `classify_regime`, `actual_vs_target_weights`, `concentration_metrics` are
implemented and at least one is called during the demo.

Changes:
- `mcp/src/server.ts` — add the three optional analysis tools. Each wraps a
  backend domain function or a lightweight local computation.
- `mcp/src/agent.ts` — at least one agent calls one of these tools before deciding
  its stance, and includes the result as provenance metadata in its submission.

**Exit condition:** An agent's submission provenance records that it used an RM
analysis tool, and the tool's output is verifiably correct.

---

## Ordering notes

- **Phase 1** is the highest leverage — the worker pipeline is the architecture's
  core orchestration mechanism and the current demo bypasses it entirely.
- **Phases 2 and 3** are independent of each other and of Phase 4. They could be
  worked concurrently.
- **Phase 4** (OAuth) blocks nothing downstream except its own correctness;
  everything else can proceed with bearer tokens.
- **Phases 5–8** depend on the earlier phases being in place (you need the worker
  lifecycle, research signals, and memos before you can assert frontend rendering
  or cross-role denial).

Recommended order:

```
P1 (worker) → concurrent (P2, P3) → P5 (authz) → P6 (frontend) → P7 (multi-session) → P8 (analysis tools)
                                  ↕
                                P4 (OAuth) — anytime, but independent
```
