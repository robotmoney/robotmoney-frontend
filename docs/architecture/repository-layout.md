# Repository layout

Part of the [architecture](README.md). Split out of the former single `docs/architecture.md` on 2026-09-23; section numbering inside is unchanged so old citations still resolve.

## 3. Repository layout (split-ready)

Three top-level directories. They live together now for convenience but are
designed so each becomes its own repo via `git filter-repo`, with no code changes.

```
robotmoney-frontend/
  contract/    # the ONLY thing shared across the boundary: route paths + DTO types
  packages/analyst-sdk/  # pure regime compute (backend re-exports it); installs and runs alone, see D57
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

### `packages/analyst-sdk/`

A second shared seam, for compute rather than types (D57, issue #1095). The pure
regime pipeline (`analyze/`, `transform/`, `types.ts`, `access/provider.ts`) lives
there; `backend/src/analytics/` keeps one-line re-export shims at the old paths.
It imports nothing from `backend/`, touches no filesystem, database or
environment variable in `src/`, and installs in a directory holding only the
package. `scripts/tests/unit/analyst-sdk-purity.test.ts` enforces that.

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

One live-network surface exists, and it is deliberately not a merge gate.

The **observed, ungated** one is `.github/workflows/production-drift-audit.yml`
(`CI_CLASS: heavy`): a schedule-only auditor that reports and never gates. It
asks four questions, and these four only:

| # | Check |
|---|---|
| **A** | Does the `rmpc` release the onboarding skill **pins** still exist, and does robotmoney-core still publish archives whose sha256 match the ones the skill **carries**? |
| **B** | Does `SWARM_ONBOARDING_SKILL_URL` still serve a real, complete procedure rather than a deprecation stub? |
| **C** | Does the **served** copy carry an unverified `curl … | tar xz` install form? |
| **D** | **Negative control**: does a sibling `.md` path on the same host that cannot exist come back non-200, carrying none of the skill's markers? |

**There is no gated live-network surface any more, and that is a decision, not a
gap.** `contract`'s `contract/tests/live/` — the one directory whose cost class
was "reaches the public internet", and the only merge gate that ever did — is
**deleted**, along with the `test:live` script, the `contract.yml` step that ran
it, and the file itself. Its assertions are B, C and D above; the one hermetic
assertion it also held (that the URL constant names a skill directory above
`SKILL.md`) is merge-gated at
`contract/tests/unit/swarm-onboarding-skill-url.test.ts`.

The reason is that **whether `robotmoney.network` answers is not a property of the
commit under review.** It depends on deploys, DNS, TLS, CDN state, and renames
and releases in robotmoney-core — none of which any diff in this repository can
change. A required job that reaches the public internet on every pull request
means any contributor with a flaky connection, and any upstream hiccup, holds an
unmergeable PR for a reason the diff cannot fix. That was not a hypothetical: the
`contract` job was RED on an open pull request with `Received: 502`, caused by
nobody in that pull request. Required reading whose resolution is outside the
repository is the shape D26 was written to delete, and it is now deleted on both
counts.

The accepted cost, stated so it is never discovered the hard way: **no required
check in this repository verifies that the skill endpoint is alive, or that what
it serves is the skill.** Not one, and not any nightly mirror of one. The 404
that issue #484 was filed about — a guard that documented a `nightly-fetchers.yml`
job which never existed, so it had executed in no CI job at any point in its life
while the URL it guarded 404'd in production for two days — is now found by
tonight's audit rather than by the pull request that caused it. Slower detection,
bought on purpose, and paid for by a merge set that cannot go red for anything
outside the repository.

**What this auditor does NOT check, stated plainly because it is a decision and
not an oversight.** It does not check deploy freshness — whether the bytes served
at the skill URL match `frontend/public/skills/swarm-onboarding/SKILL.md` in this
checkout. That comparison was implemented by `contract/src/skill-parity.js`
(`describeSkillMismatch`); **that module and its offline unit test have been
deleted**, and nothing in this repository asks the deploy-freshness question any
more — not the auditor, not a merge gate, not a unit test, and not under some
other name. The consequence, so it is never discovered the hard way: **nothing in
CI reports a stale deploy.** If `main` carries a correct skill and production is
still serving the previous one, no job in this repository will say so. Deploy
freshness is now the **deploy pipeline's job**: it is a fact about whether a
publish ran, and this repository has no deploy workflow, so the only place that
fact can be observed is the deploy tooling or a human watching it. Do not
"repair" this by reintroducing a served-vs-repo byte comparison, and do not
"repair" it by giving the auditor a non-zero exit. The comparison was also never
a strong check for the failure that actually breaks members: in the scenario
that matters — robotmoney-core yanking or re-uploading the pinned `rmpc` release
— the served copy and the repo copy keep matching each other perfectly, because
neither of them moved. That is check A, and it is the one the merge set
structurally cannot see.

B, C and D are a **MOVE off the merge gate, not a new addition** — all three were
code that sat in the deleted live test file, which was removed with them. They left for the reason above: a correct merge must
not red a required check for something no commit can repair. B carries the merged
assertion set — the 200, the front-matter `name:` that must agree with the slug
the URL itself names, the `rmpc` marker, the whole procedure set, the
deprecation-stub negative and the procedure floor — merged rather than copied, so
that where the live test and the old B disagreed the stronger form won. C is a
**security guard, not a content diff**, and its independence is deliberate and
load-bearing: the unverified `curl … | tar xz` form pipes a downloaded archive
into a root-privileged extractor with no checksum check, issue #748 closed it in
the repo copy, and a stale deploy can still serve the pre-#748 block to a
genuinely NEW member while every offline check stays green, because the offline
checks read the repo file. C is asserted over the served body directly, keeps its
own status line, and reports UNKNOWN — never a pass — when the fetch did not
complete or when the origin answered with an error page instead of the document.
Do not fold C into B and do not make it contingent on anything else in the
auditor.

B asserts the PROCEDURE, not the label, because a 200 with the right
front-matter `name:` proved insufficient in production: robotmoney-core replaced
the file with a 1,951-byte deprecation stub whose front matter kept the right
`name:`, whose body mentioned `rmpc`, and which cleared every size floor, while
reading, verbatim, "This file is a compatibility stub. It contains no
instructions to follow." Agents were handed a signpost instead of a procedure and
CI stayed green for two days.

**D exists because B cannot check itself.** Every marker in B is a positive
assertion over a body that is supposed to be good, and a positive assertion over
a good input says nothing about whether it would have gone red on a bad one: an
origin that answers 200 with an SPA shell, or an error page that happens to
contain `rmpc`, renders B green over garbage. D fetches a sibling `.md` path that
cannot exist — the `.md` is load-bearing, because the site server answers
extension-less paths with the SPA shell at 200 (website-server/nginx.conf, #954) —
and reports what came back. The direction of each outcome is the substance of the
check, and it is written out at the D section of `scripts/production-drift-audit.ts`:
a 404 carrying none of the markers is the only outcome that reports OK; a 200, or
a 404 carrying a marker, reports DRIFT; and anything else — a 5xx, an unreachable
host, a discriminator that could not be computed — reports UNKNOWN, never OK,
because a non-404 failure status measures the origin's health rather than the
discriminator. A reporter that always exits 0 cannot assert its control with an
exit code, so it reports it as a row, and the row is only worth anything if
somebody reads it.

The auditor always exits 0 — a red report body on a green job is the intended
outcome — and a check that could not run is reported UNKNOWN, never omitted and
never rendered as a pass. Its red nightly means something different from a red
merge; E6 records the exemption.

**L2 — Shared code is named for its domain, never for its consumer.** `stack/`,
`agent/`, `toolchain/` state what belongs in them; `lib/`, `utils/`, `helpers/`
invite anything. Code shared between the smoke runtime and test/eval time lives in
a domain directory, not in a bucket named after who imports it.

Per-package test layout, by cost class:

| Path | Class | Needs | Runs |
|---|---|---|---|
| `<pkg>/tests/unit/` | unit | nothing | every PR (the default `bun test` target) |
| `<pkg>/tests/integration/` | integration | Docker, a local stack | PR ready-for-review |
| `<pkg>/tests/live/` | live | real external network | its package's workflow — PR (path-gated), merge to main, and the nightly mirror. **No package has a `tests/live/` directory today**, and that is a decision rather than an oversight: the one that existed (`contract/tests/live/`, the skill endpoint's reachability and procedure assertions) was removed because none of those assertions is a property of a commit, so a directory whose name promises "reaches the public internet" would be a lie and a merge gate over it would be required reading whose exit is outside the repository. Anything that genuinely needs the live network is a REPORTER (below), not a `live` suite. |
| `evals/` | eval | Docker + network + **real inference** | nightly, sweep-only |

**Why an empty `tests/live/` was not left behind.** `bun test <dir>` exits 1
against an empty or a missing directory on bun 1.3.x — verified on 1.3.14, not
assumed — so keeping the directory while deleting its last file would leave
the `test:live` script as a step that is permanently red, or (if the step went too)
as a script that no workflow invokes. The second is the exact false green issue
#484 was filed about: `test:live` sat declared in `contract/package.json` and
invoked by zero of eleven workflows for the whole life of the guard it named.
Deleted beats both, and
`scripts/tests/unit/ci-workflows-structure.test.ts` now asserts the absence, so
the next person to reach for a network test in a merge gate meets a red rather
than a precedent.

The one live-network surface in this repository sits outside that table on
purpose: `.github/workflows/production-drift-audit.yml` (`CI_CLASS: heavy`)
reaches robotmoney.network and robotmoney-core's release API, but it is not a
test path, has no pass semantics, and never gates — schedule-only, exempt from
the merge set (E6), always exit 0. It is a REPORTER, not a `live` suite; reading
its findings as merge signal would re-create the gate it was split out to remove.
All three of its served-document checks (B, C, D) MOVED out of
`<pkg>/tests/live/` rather than being written fresh alongside it, so there is now
no overlap to reason about and no second opinion: the auditor is the only place CI
looks at what production is serving. It does not and never did cover deploy
freshness; that question is answered by nothing in this repository (see above).

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
