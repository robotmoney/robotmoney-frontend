# Repository layout

Part of the [architecture](README.md). Split out of the former single `docs/architecture.md` on 2026-09-23; section numbering inside is unchanged so old citations still resolve.

## 3. Repository layout (split-ready)

Three top-level directories. They live together now for convenience but are
designed so each becomes its own repo via `git filter-repo`, with no code changes.

```
robotmoney-frontend/
  contract/    # the ONLY thing shared across the boundary: route paths + DTO types
  frontend/    # buildless SPA (static files): shell, views, Alpine, CSS, assets
  backend/     # Bun API (Bun.serve) + Postgres task queue/workers + SQL migrations (owns the DB)
  docs/        # this documentation
```

### The boundary

- **Nothing in `frontend/` imports from `backend/` or vice versa.** Both depend
  only on `contract`.
- The frontend reaches the backend **only over HTTP**, through
  `frontend/public/assets/js/app/lib/api.js`, using the API origin from
  `window.RM_CONFIG.API_BASE_URL` (set by `frontend/public/config.js`). `""` means
  same origin — the default, since the `api` co-serves this surface's SPA assets at
  its subdomain root (in production, `swarm.robotmoney.net`; see the
  topology's [subdomain map](network-topology.md#3-the-surfaces--subdomain-map)).
- The database schema and migrations live in `backend/`; the frontend knows only
  the DTOs in `contract`.

### `contract/`

- `src/routes.js` — endpoint paths + a `path()` helper. Runtime values, the single
  source of truth for URLs. Imported by both sides.
- `src/*.d.ts` — request/response DTOs as pure TypeScript declarations (no runtime
  form). The backend uses them via `import type`; the frontend's editor tooling via
  JSDoc `import('@robotmoney/contract').Foo`.
- The frontend **vendors** `routes.js` (copied to
  `frontend/public/assets/js/app/contract/` by `bun run sync-contract`) so static
  serving needs no symlinks. The copy is a file copy, not a build; CI runs
  `bun run check-contract` to prevent drift.

On the eventual split, `contract/` is published (private npm registry / GitHub
Packages) or vendored via git submodule; both repos pin a version. Bumping the
contract is the explicit, reviewable coupling point.

The split frontend deploys as its own container on the same DO infrastructure
the api runs on (not Cloudflare Pages), reachable cross-origin via CORS rather
than same-origin — D43 covers why (D29's static-assembly coupling means the
repo split alone wouldn't decouple deploys) and what's implemented so far
(`backend/src/api/cors.ts`, `CORS_ALLOWED_ORIGINS`).

### Test, eval, and tooling layout

Status: target layout (D23). Two rules govern where things go.

**L1 — A directory is a selectable unit of CI cost.** CI selects by path
(`bun test <dir>`, `paths-ignore`, workflow globs), so any subset CI needs to run
*without* the rest must have its own directory. A test that needs Docker, a real
network, or a real model call never shares a directory with a pure unit test.

**CI fan-in.** Per-PR assurance is split into one workflow per assurance domain
(issue #275): `unit` (root typecheck and unit tests), `repo-guards`, `contract`,
`integration` (the `scripts/tests/integration` cost class), `backend`,
`research-pipeline`, `web-client`, `onboarding-eval-rails`, and `e2e`. Each of
these is **directly required** in branch protection — there is no fan-in/gate
workflow aggregating them (see "No fan-in gate" below for why, and for what
used to be here).

Every domain besides `unit` and `repo-guards` narrows further by embedding its
OWN `dorny/paths-filter` change-detection job and gating its main job's `if:`
on that job's own filter output — but ONLY on `pull_request` events
(`github.event_name != 'pull_request' || (...)`), so a `push` to the default
branch always runs every workflow in full regardless of what changed
(asserted by `ci-workflows-structure.test.ts`). `unit.yml` and
`repo-guards.yml` are the two deliberate exceptions: both are cheap enough
(no Docker, no network) to run unconditionally on every PR, and both say so in
their own header comments. Because every path-based skip is a **job-level**
`if:` guard (never a workflow-level `on.paths`/`paths-ignore`), a legitimately
skipped domain still reports a real `skipped` conclusion to the GitHub Checks
API — the property that makes requiring these workflows directly, rather than
through a fan-in aggregator, safe: branch protection sees a concluded check
either way and never hangs waiting for a context that never arrives.

**No fan-in gate (issue #275 addendum 2, 2026-07-30).** This design originally
had a `ci-gate.yml`/`scripts/checks/ci-gate.ts` fan-in: a single required
`gate` job that polled `gh run list` for every sibling workflow's conclusion on
the current commit and enforced the test-coverage invariants (needed-domain
success, failure/cancellation propagation, invariant-4 incorrect-skip
rejection, invariant-2 zero-test rejection) centrally. It was removed after a
production incident on PR #316: on a `pull_request` event, bare `github.sha`
resolves to GitHub's synthetic PR merge commit, not the branch's real head
commit every sibling workflow's run is recorded under, so `gh run list
--commit $GITHUB_SHA` matched zero runs and the gate burned its entire polling
budget before failing — even though every sibling workflow had already
succeeded. That specific bug was fixed (resolving `GITHUB_SHA` from
`github.event.pull_request.head.sha` on `pull_request` events), but the repo
owner's final decision was to remove the fan-in mechanism entirely rather than
keep a cross-workflow `gh run list`-polling design going forward, and to
require each real-work workflow directly instead — accepted as safe per the
job-level-skip property above. Issue #348 tracks investigating a structurally
sounder fan-in replacement (likely `workflow_run`-based, avoiding the
polling-for-an-external-commit class of bug entirely) for if/when one is
needed again. Flipping the actual branch-protection required-check list to
list these workflows individually (`unit`, `backend`, `contract`, `web-client`,
`integration`, `e2e`, `repo-guards`, `research-pipeline`,
`onboarding-eval-rails`, `docs-lint`) is an out-of-band administrative step in
the GitHub UI, not something automatable from this repo.

- `research-pipeline` (issue #275 addendum) narrows the coarse `backend`
  category to the GeckoTerminal/analytics-fetch surface specifically
  (`backend/src/analytics/**`, `backend/src/chain/**`). It owns exactly the two
  tests whose entire subject is that surface
  (`backend/tests/geckoterminal-resilience.test.ts`,
  `backend/tests/token-prices-resilience.test.ts`) — `backend.yml`'s own
  `bun test` excludes them (`--path-ignore-patterns`) so an unrelated backend
  change (swarm, admin, chain-agnostic routes) no longer pays for them.
  Broader tests that also happen to touch analytics/chain code but assert
  API-route behavior outside that surface
  (`backend/tests/api/wallet-balances.test.ts`,
  `backend/tests/api/dashboards-live.test.ts`) stay in the general `backend`
  suite, since narrowing them to this filter would regress their non-analytics
  coverage.
- `onboarding-eval-rails` (issue #275 addendum) is the inference-off
  member-agent rails check
  (`scripts/tests/integration/onboarding-eval-infra.test.ts`), split out of the
  `e2e` monolith: it brings up its own minimal `core`-profile stack
  (postgres + api only, via the shared `scripts/stack` module) and never needed
  `e2e`'s full LIVE smoke boot. It stays system-correctness (Docker-backed,
  deferred on draft PRs), gated on the paths that surface actually depends on
  (`evals/**`, `scripts/lib/member-agent/**`, `scripts/lib/rmpc-fetch.ts`,
  `scripts/lib/onboarding-eval.ts`, `scripts/lib/swarm/**`,
  `backend/src/swarm/**`). The REAL-inference eval (the one that spends a
  model token) stays inside `e2e.yml`'s "Full-stack smoke" step, unchanged — it
  deliberately reuses that already-booted LIVE stack rather than standing up a
  second one.
- `web-client` (issue #275 addendum, critical-bug fix — see "No fan-in gate"
  above for what backed this requirement before it was removed; superseded and
  renamed from `frontend.yml`/`name: frontend`, 2026-09-17, D45) is the web
  client's OWN merge gate and CI/CD policy, versioned independently of the
  api/backend and the contract via `frontend/package.json`'s
  `@robotmoney/web-client` manifest. Only four things block a client merge:
  the client's unit tests (`bun run --cwd frontend test`, the subset of
  `scripts/tests/unit/` named in `frontend/test/unit.list`), the static
  assembly/prerender failing to build, the preview page failing to load at
  all, or a Chrome console error while Playwright loads it. The last two are
  both covered by `frontend/test/browser/preview-routes.spec.ts`, which sweeps
  every `sitemap.xml` route inside the FIXTURES-mode preview (goldens answer
  `/api/*`, `scripts/preview-server.ts` — no `BACKEND_URL`, no Docker), plus
  the pre-existing `preview-smoke.spec.ts` and `api-unreachable.spec.ts` — a
  fast, feature-correctness-class addition, not a substitute: `e2e.yml`'s
  `test:browser` step still runs the ENTIRE `frontend/test/browser/` suite,
  including specs that need the live backend the full smoke boot provides.
  The preview wrapper's `?api=` switch can also point `/api/*` at a live prod
  or stage api instead of goldens (mainly a developer tool — `bun run --cwd
  frontend check:prod` / `check:stage`); `web-client.yml` runs that sweep too,
  but ADVISORY only (`continue-on-error: true`, reported in the job summary) —
  a live host being unreachable says nothing about the PR's client code, so it
  can never block the merge. Backend/db/api changes get their own coverage of
  the client surfaces in `backend.yml`/`integration.yml`/`e2e.yml`, unchanged.

System-correctness workflows (`backend`, `research-pipeline`, `integration`,
`onboarding-eval-rails`, `e2e`) defer on draft PRs; the feature-correctness
workflows (`unit`, `repo-guards`, `contract`, `frontend`) continue to execute
there — cheap enough (no Docker) to gate early regardless of draft state.

The one live-network exception is deliberate and bounded (issue #484):
`contract` runs `contract/tests/live` — a single HTTPS GET asserting
`SWARM_ONBOARDING_SKILL_URL` still returns 200. It is the only discovery link in
the D21 onboarding flow, a 404 there raises no error anywhere in this repo, and
the guard's previous schedule-only home did not exist, so it had never executed
in CI at all while the URL 404'd in production for two days. It runs on the
per-PR path rather than nightly-only so the red lands on the PR that causes it,
gated behind `contract`'s existing `contract/**` paths-filter. The accepted
cost: a raw.githubusercontent.com outage reds a required check on `contract/**`
PRs. That is the intended direction — per the loud-skip-never invariant, an
unreachable external resource must fail, never skip.

**L2 — Shared code is named for its domain, never for its consumer.** `stack/`,
`agent/`, `toolchain/` state what belongs in them; `lib/`, `utils/`, `helpers/`
invite anything. Code shared between the smoke runtime and test/eval time lives in
a domain directory, not in a bucket named after who imports it.

Per-package test layout, by cost class:

| Path | Class | Needs | Runs |
|---|---|---|---|
| `<pkg>/tests/unit/` | unit | nothing | every PR (the default `bun test` target) |
| `<pkg>/tests/integration/` | integration | Docker, a local stack | PR ready-for-review |
| `<pkg>/tests/live/` | live | real external network | its package's workflow — PR (path-gated), merge to main, and the nightly mirror |
| `evals/` | eval | Docker + network + **real inference** | nightly, sweep-only |

`backend/tests/` is the reference implementation of this and needs no change: it
is subdivided by surface (`api/`, `db/`), provisions its dependency in
`preload.ts` (which fails loudly rather than skipping), separates `support/` from
`fixtures/`, and already tags cost in filenames (`*-live.test.ts`).

Harness code (today `scripts/`) separates by role rather than by medium:

```
bin/         executable entrypoints — the `bun run` targets
smoke/        smoke RUNTIME (the long-lived process): main, tui, schedule, swarm/
stack/       SHARED compose lifecycle: profiles (core | full), ports, volumes
agent/       SHARED member-agent primitives: Dockerfile, run, config, classify
toolchain/   SHARED external-binary fetchers (rmpc)
checks/      one-shot CI checks where the exit code IS the verdict
ops/         credential/deploy utilities
```

**L3 — Dependency direction.** Tests and evals may import runtime and shared
code; **runtime must never import test or eval code**; both may import shared.
This is enforced by a grep check in the same shape as
`scripts/checks/check-model-selection.sh`, not by convention alone. A second
grep asserts §11.3 E2 — that no mock, injection seam, or conditional skip
appears under `evals/`.

**Migration is incremental, not a big-bang reorg.** New directories are created
as the work that needs them lands (D22's extractions land directly in `stack/`
and `agent/`); the cost-class split of `scripts/tests/` is a mechanical file move
with no logic change; renaming `scripts/` itself is explicitly **not** planned
(D23).

---
