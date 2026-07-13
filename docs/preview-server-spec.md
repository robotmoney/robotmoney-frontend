# Preview server & goldens — spec

**Status:** the preview server (`scripts/serve-preview.ts`) + goldens
(`goldens/api-goldens.json`) + capture (`scripts/update-goldens.ts`) are
implemented. The CI **drift gate** (§5) is specified here and not yet wired — its
one open decision is called out in §5.3.

## 1. Purpose

Lightweight, backend-free hosting for **agentic development of the marketing
surface**. The buildless SPA under `frontend/public` *is* the marketing site. A
contributor — human or agent — with a git checkout must be able to **view** the
site and **iterate** on it without standing up the backend (Bun API + Postgres +
workers), and must be able to keep the mock data **correct** as the system
evolves. Supersedes the deprecated single-file `file://` "frozen" distribution
(removed; see `docs/decisions.md`).

## 2. Concepts

- **Goldens** — one committed JSON file, `goldens/api-goldens.json`, of mock API
  responses keyed by request pathname. A *mock*: **field shapes are real, values
  are point-in-time.**
- **Preview server** — a thin HTTP server that serves the live `frontend/public`
  and answers `/api/*` from the goldens. No app changes.
- **Capture** — `bun run goldens:update`: (re)build the goldens by fetching from a
  **real running system**.

## 3. Goldens file

```jsonc
{
  "version": 1,
  "source": "capture:http://…",      // provenance of this snapshot
  "note": "real shapes, point-in-time values",
  "routes": {
    "/api/dashboards/regime-snapshots": { "latest": …, "history": [ … ] },
    "/api/committee/members": { "members": [ … ] },
    "/api/committee/members/athena": { … },
    "/api/dashboards/research-signals/channel-divergence": { … },
    "/health": { … }
  }
}
```

- **Keyed by pathname**, query dropped — a golden is one point in time.
- **Covers every route the frontend calls**, including parameterised
  member/session detail routes (discovered from the captured list bodies).
- **Stable key order** (sorted) so diffs are legible.

## 4. Preview server (`scripts/serve-preview.ts`)

- `bun run preview` — binds a **random free port** (`port: 0`, printed on start)
  so concurrent previews never collide; `PORT=NNNN` pins it.
- Serves files from `frontend/public` (**live** — edits show on refresh).
- `GET /api/*` and `/health`: return `routes[pathname]` (query dropped); 404 JSON
  if the route has no golden.
- Non-GET `/api/*`: accepted **no-op** (`{ ok: true, mocked: true }`) — a snapshot
  has no mutable state.
- Any other path: serve the static file, else fall back to `index.html` (so
  client-side deep links like `/regime` load).
- The SPA is **unmodified**: `config.js` stays same-origin (`API_BASE_URL: ""`),
  the SPA requests `/api/*`, and the preview server answers. No `STATIC_DATA_BASE`,
  no fetch/history shim, no `file://`.

## 5. Correctness: capture + drift gate

### 5.1 Capture (`scripts/update-goldens.ts`)

`BACKEND_URL=… bun run goldens:update` walks every route the frontend requests,
fetches each from a **real running system** (a deployed test cluster or a local
`bun run demo` stack), and rewrites the goldens. Any route that errors fails the
capture **loudly** — a golden must never silently go missing. Goldens are **never
hand-authored and never derived from other fixtures**, so their shapes stay
faithful to what the backend actually returns.

### 5.2 Responsibility

**Correct goldens are the responsibility of the change author.** There is **no
nightly regeneration.** An agent (or human) whose change alters an API's field
shape must recapture the goldens **in the same PR** — the same discipline as
updating tests or the contract (`check-contract`).

### 5.3 The drift gate (to be wired)

A CI check that **blocks a PR whose goldens no longer match the code**, so a stale
golden can't merge. The important assertion is that the **fields are correct**,
not that the numbers are — value churn must never trip it.

The one open decision is the gate's oracle:

- **(A) Live-cluster gate.** CI fetches every route from a deployed test cluster
  and compares **field structure/types** (not values) to the committed goldens.
  Most faithful to reality, but the per-PR check depends on a live external system
  (flake/availability) and hits a version-skew problem: a shape-changing PR fails
  against a cluster that hasn't deployed it yet.
- **(B) Hermetic contract gate (recommended).** The agent captures goldens from
  the real system (their responsibility); CI verifies **offline** that the goldens
  conform to the **contract types** shipped in the *same PR* (`contract/src/*.d.ts`)
  and that every field the frontend reads is present. No network, no flake, and a
  shape change and its golden move together in one PR. The deployed cluster is the
  *authoring-time* oracle; the contract is CI's gate.

**Recommendation: (B).** It satisfies "fields checked against a real system"
(capture time) and "block on drift" (hermetic per-PR) without coupling the merge
gate to a live deployment. On failure the message is: *"Goldens are stale — run
`bun run goldens:update` (against a running backend) and commit."*

Regardless of A/B, coverage is asserted structurally: the goldens' route set must
equal the set of routes the frontend calls (scan `api.get/post/health` +
`path(ROUTES…)` call sites). A frontend route with no golden, or an orphan golden,
fails the gate.

## 6. Data fidelity

Goldens carry **real shapes but mock / point-in-time values.** Preview is for
**layout, copy, components, navigation** — not for trusting numbers, charts, or
time-series. For realistic, evolving data (real analytics + simulations) run the
full stack with `bun run demo` (see `demo-spec.md`), which produces far better
data simulations than a static snapshot ever will.

## 7. Non-goals

- Public hosting / a shareable URL (preview is local, for contributors).
- Real values in goldens (that's what `bun run demo` is for).
- A built/bundled dist (the SPA is served live from source).
