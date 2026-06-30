# Demo Specification

What `bun run demo` must demonstrate to exercise the full Investment Committee lifecycle —
a single command that provisions everything, runs one complete session end-to-end, keeps
the stack live, and tears down cleanly.

---

## 1. Lifecycle stages

Every stage of the session state machine must be exercised with the real domain code:

```
scheduled → brief_published → collecting → window_closed → aggregated → published
```

| Stage | What the demo must exercise |
|---|---|
| **Research pipeline** | At least one research signal tool runs (channel-divergence, late-cycle, or future tool) and its output lands in `research_signals`. The brief that members read must include research signal data alongside regime. |
| **Regime classification** | A regime snapshot is written and readable. If the live provider (`FetcherProvider`) is unavailable, the seeded provider (`seededProvider`) is acceptable for hermetic runs — but the write path (same tables, same domain logic) must match production. |
| **Open session** | A new session is created with `scheduled` state, assigned a subject from the rotation. |
| **Publish brief** | Brief is assembled from regime + research signals + subject snapshot + recent session history. Window opens with a `window_closes_at` deadline. |
| **Collecting (submission window)** | Multiple autonomous agents connect via MCP, read regime/brief, sign payloads, and submit. At least one agent no-shows (recorded absent, not fabricated). Out-of-window submissions are rejected. Cross-role writes are denied. |
| **Close window** | Window transitions to `window_closed`. Submissions after this point are rejected. |
| **Aggregate** | Deterministic rollup: stance counts, mean confidence, absence list, synthesis string. No host-authored takes. |
| **Publish** | Session is marked publicly visible. |

## 2. Worker orchestration

Transitions must go through the **worker job pipeline**, not direct domain calls:

- Each lifecycle transition is a job kind (`committee.open_session`,
  `committee.publish_brief`, `committee.close_window`, `committee.aggregate`,
  `committee.publish`) enqueued via the scheduler or explicitly for the demo.
- Jobs are claimed and executed through the real `FOR UPDATE SKIP LOCKED` claim loop.
- Job schedules are seeded so a no-intervention run would also progress through the
  lifecycle (even if the demo also triggers them explicitly for determinism).

## 3. Surfaces

### 3.1 MCP server

All MCP tools listed in the architecture must be demonstrated:

| Tool | Status in demo |
|---|---|
| `get_regime` | ✅ Current |
| `get_open_session` | ✅ Current |
| `list_sessions` | ✅ Current |
| `get_session` | ✅ Current |
| `get_brief` | ✅ Current |
| `get_signing_payload` | ✅ Current |
| `submit_recommendation` | ✅ Current |
| `get_subject_snapshot` | ✅ Current |
| `post_memo` | ✅ Current |
| `classify_regime` (optional analysis) | ✅ Current |
| `actual_vs_target_weights` (optional analysis) | ❌ Not implemented |
| `concentration_metrics` (optional analysis) | ✅ Current |

The MCP transport must use **Streamable HTTP with OAuth 2.1** (bearer tokens are a
dev-mode fallback only; the OAuth flow must be exercised in the demo).

### 3.2 REST API

The REST sibling routes must be demonstrated exercising the same domain code:

- `POST /api/committee/admin/open`
- `POST /api/committee/admin/brief`
- `POST /api/committee/admin/close`
- `POST /api/committee/admin/aggregate`
- `POST /api/committee/admin/publish`
- `POST /api/committee/submit`
- `POST /api/committee/regime` (role-gated analytics write)
- `GET /api/committee/members`
- `GET /api/committee/sessions` / `GET /api/committee/sessions/:id`
- `GET /api/committee/brief?date=&subject=`
- `GET /api/dashboards/regime-snapshots`
- `GET /api/dashboards/research-signals/:key`

### 3.3 Frontend

At least one headless assertion must verify that the published session renders
correctly in the SPA:

- Signed takes display with verification badges (green check / red mismatch).
- Absent members are listed as absent.
- Regime chart and research signal views render.
- The `/committee` view shows the published session.
- `memoUrl` values (if any) render as outbound links.

## 4. Actors and roles

Every actor role must be exercised and cross-role write denial asserted:

| Actor | What the demo must do |
|---|---|
| **Committee member** (× N agents) | Connect via MCP, read regime/brief, sign with own ed25519 key, submit recommendation. One agent deliberately no-shows. Members must NOT be able to write regime data or mutate sessions. |
| **RM analytics provider** | Write a regime snapshot (and optionally research signals) under a scoped credential. Must NOT be able to submit recommendations or mutate sessions. |
| **Protocol host (worker)** | Drive lifecycle transitions through the job queue. Must NOT generate member takes. |
| **Public reader** | Anonymous reads: published sessions, regime, research signals, member list. Must NOT write anything. |

## 5. Security invariants

Each invariant must be asserted (either via E2E assertions or hermetic tests that the
demo also runs):

| Invariant | Assertion |
|---|---|
| No fabricated takes | Absent members are absent in the published aggregate; their count matches registered members minus submitters. |
| Signature verification | A tampered payload (mutation of stance, confidence, memoUrl, nonce) invalidates the submission. |
| Nonce uniqueness | Replay of the same nonce is rejected. |
| Window enforcement | Submissions before brief_published or after window_closed are rejected. |
| Cross-role denial | Member cannot write regime; analytics provider cannot submit; neither can close/aggregate/publish. |
| TOCTOU safety | Concurrent submissions for the same session from different members both succeed (different nonces, different members). |
| No plaintext secrets | Access keys are stored as sha256 hashes; private keys are never transmitted. |
| memoUrl covered by signature | Tampering with memoUrl after submission invalidates the signature (`backend/tests/signing.test.ts` already covers this — the demo must also exercise it). |

## 6. Agent autonomy

Each agent must:

1. Generate its own ed25519 keypair (client-side).
2. Register via the member onboarding flow.
3. Connect to MCP with its own OAuth session (or bearer token in dev mode).
4. Read regime + brief + research signals via MCP tools (autonomously — no hardcoded
   stance based on agent identity).
5. Decide a stance using a deterministic but non-trivial policy (weighted composite of
   regime signals + per-agent bias).
6. Fetch the canonical signing payload via `get_signing_payload`.
7. Sign with its own private key.
8. Submit via `submit_recommendation`.
9. Optionally publish a memo via `post_memo` (or via `memoUrl` in the submission).

RM never holds the private key at any point.

## 7. Hermeticity and cleanup

- Zero external dependencies: the demo must not reach out to FRED, Yahoo, CoinMetrics,
  or any live API. The `seededProvider` supplies deterministic data.
- Random ports + unique compose project name: concurrent runs do not collide.
- On any exit path (Ctrl-C, SIGTERM, startup failure, assertion failure):
  `docker compose down -v` — nothing left behind.
- A missing Docker dependency (Postgres image, build failure) must fail the run
  loudly, never silently skip.

## 8. Agent memo workflow (`memoUrl` + `post_memo`)

The demo must demonstrate the full agent memo lifecycle:

1. At least one agent publishes a long-form memo at a member-hosted URL (or a
   simulated URL within the demo).
2. The `memoUrl` is included in the submission payload and covered by the signature.
3. The `post_memo` MCP tool (or equivalent) writes the memo to the member's own
   storage and returns the URL.
4. The published session frontend renders the `memoUrl` as a link.
5. Tampering with the `memoUrl` after submission invalidates the signature (asserted
   in `signing.test.ts`).

## 9. Multi-session awareness

The demo should demonstrate at least two sessions (or the concept of rotation):

- Session N completes the full lifecycle.
- The brief for session N+1 references the outcome of session N.
- The session list view (`list_sessions`) shows both.

## 10. Demo output

When the demo completes its E2E assertions and enters keep-alive mode, it must print:

```
── Robot Money demo ────────────────────────────────────
  Site:       http://localhost:<api>/
  Regime:     http://localhost:<api>/regime
  Committee:  http://localhost:<api>/committee
  Research:   http://localhost:<api>/research/<key>
  MCP:        http://localhost:<mcp>/health

  Session #<id> — <subject> — <stance summary>
  Members present: <n>  Absent: <m>  Published: yes

  Press Ctrl-C to shut down.
```
