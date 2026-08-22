# Contributing

This repo is built for **agentic development** — most changes are made by an AI
agent (e.g. Claude) driving a git checkout on the contributor's behalf. The
sections below are written for **both humans and agents**.

The website under `frontend/public` is the **marketing surface**: a buildless
Alpine + Chart.js SPA (no build step). You can develop it with **no backend,
database, or workers** using **preview mode**.

## View the site (preview mode)

```bash
bun install          # once
bun run preview      # serves the live SPA; open the URL it prints
```

- `bun run preview` serves the working tree **in place** on a **random free
  port** (printed on start) — no copying, no build: edit a file and refresh.
- The wrapper (`frontend/preview/index.html`) runs the live SPA inside an iframe
  and intercepts `/api/*` calls client-side, answering them from committed
  goldens (`goldens/api-goldens.json`). No backend needed. The experience is
  identical to the hosted branch preview (push to a `preview/*` branch —
  Cloudflare Pages' Git integration builds and hosts it; see the preview
  section of [`docs/architecture.md`](docs/architecture.md)).

**Agent note:** to let a contributor view the site, start `bun run preview` and
give them the printed URL. It runs in the foreground — keep it running while they
review; stop it with Ctrl-C.

## Update the site

1. Edit files under `frontend/public/` (views in `views/*.html`, styles in
   `assets/css/`, behaviour in `assets/js/app/`). Refresh the preview to see
   changes — no rebuild.
2. If your change **adds or alters an API call or its expected shape**, update the
   goldens so the mock stays correct (see next section).
3. Open a PR (agents: via the normal PR flow). CI runs `typecheck`,
   `check-contract`, and tests.

## Keep the goldens correct (your responsibility)

Goldens are mock API responses the preview wrapper replays. **Correct goldens are
the responsibility of the change author** — there is no nightly job that fixes
them for you, and a CI **drift gate** (`scripts/tests/unit/goldens-drift.test.ts`)
will block a PR whose goldens no longer match the code (see the preview/goldens
section of `docs/architecture.md`).

Goldens must be **captured from a real running system** — never hand-edited,
never derived from other fixtures — so their **field shapes** match what the
backend actually returns:

```bash
# Against a local full stack:
bun run demo                                             # brings up real backend + analytics
BACKEND_URL=http://127.0.0.1:<demo api port> bun run goldens:update
# …or against a deployed test cluster:
BACKEND_URL=https://<test-cluster> bun run goldens:update
git add goldens/api-goldens.json && commit
```

If CI says the goldens are stale, run `bun run goldens:update` against a running
backend and commit the result.

## Data fidelity — read this

Preview mode trades data realism for zero setup:

- **Field shapes are real; values are mock / point-in-time.** Use preview for
  **layout, copy, components, and navigation** — do **not** trust the numbers,
  charts, or time-series you see there.
- For **realistic, evolving data** (real analytics, live-ish simulations,
  scheduled recomputes, swarm sessions), run the full stack:

  ```bash
  bun run demo         # see docs/architecture.md — much better data simulations
  bun run demo:status
  bun run demo:down
  ```

- The demo is the right surface for validating anything **data-dependent**;
  preview is the right surface for iterating quickly on the **marketing surface**
  itself.

## Where changes go (and who can add files)

This repo holds the **implementation** of the site + analytics backend. Where a
file goes — and whether you may create, edit, or delete one at all — is governed
below. The **single source of truth** for who may touch what is
`.github/file-permissions.json`, enforced on every PR by
`scripts/check-contribution.ts`. There is **no owner file and no owner-review
mechanism** — the dictionary is the only authorization surface.

### Placement map

| Kind of change | Location |
| --- | --- |
| Site UI | `frontend/public/` — `views/`, `assets/css/`, `assets/js/app/`, `assets/` |
| Server / queue / workers / migrations | `backend/` |
| Shared HTTP contract | `contract/` — re-vendor with `bun run sync-contract`, never hand-edit |
| Tooling & CI scripts | `scripts/` — tests in `scripts/tests/unit/` (checkout-only: no Docker, no network, `bun run test:unit`) or `scripts/tests/integration/` (Docker- or network-backed, `bun run test:integration`). The directory IS the CI cost class (D23); never leave a test loose at `scripts/tests/`. |
| Technical docs about this repo | `docs/**/*.md` (kebab-case) |
| Reviews, audits, dated evidence | `docs/code-review/`, `docs/audits/`, `docs/reports/` — **append-only**. Never edited after the date they carry, never deleted, even when nothing links them. See [`docs/code-review/index.md`](docs/code-review/index.md). |
| Workflows | `.github/workflows/` |
| Root | config only — new root files/dirs are a review flag |

### What belongs in this repo

- This repo = **implementation** + docs describing this repo's behavior.
- **Decisions live upstream.** Brand, voice, color, strategy decisions belong in
  `robotmoney-context` (`brand/brand-sheet.md`); here you implement and link —
  you do not author the decision.
- **Roadmap / rollout / phase / TODO state** lives in the GitHub Plan issue, not
  a committed `.md` (the create-gate flags markdown task-lists added under `docs/`).
- **Provisional / unratified decisions** stay in the PR or issue thread until
  ratified upstream; they do not merge to main.
- **One concern per PR.**

### Who can change files (the file-permissions dictionary)

Permissions are an **explicit per-GitHub-user dictionary** in
`.github/file-permissions.json`, and the model is **deny by default**. Each
GitHub login maps to a set of permitted path globs **per operation**:

- `create` — add a brand-new file at a path.
- `edit` — modify an existing file.
- `delete` — remove a file.
- `all` — shorthand that grants `create` + `edit` + `delete` for its globs.
- `"*"` — a **baseline** entry whose globs are **unioned into every author**,
  including logins not otherwise listed.

**How the gate maps a diff to operations:** adding a file = `create`, modifying
= `edit`, removing = `delete`, and **renaming = `delete` of the old path +
`create` of the new path** (both halves must be permitted). An operation is
permitted iff the path matches at least one glob drawn from the union of the
author's own grants (`[op]` and `all`) and the `"*"` baseline (`[op]` and
`all`). Globs use `Bun.Glob` syntax (`**` spans directories).

> **Consequence — read this:** an author with **no entry** in the dictionary
> (and an empty `"*"` baseline) is **fully blocked — they cannot even edit an
> existing file**, let alone create or delete one. There is no implicit
> "anyone may edit" fallback. Every contributor who needs to change anything
> must be **listed explicitly** (or granted broadly via `"*"`).

**Worked example.** A dictionary entry looks like:

```json
"fernandezdavid": { "edit": ["frontend/**", "docs/**"], "create": ["**/*.test.ts"] }
```

`fernandezdavid` may **edit** anything under `frontend/` or `docs/` and **create**
test files anywhere, but may **not** create non-test files (e.g. a new view),
**delete** anything, or touch `contract/`, `backend/**/migrations/`, or
`.github/` — those stay with the admins until explicitly granted.

Today the dictionary seeds three admins (`lucky-tensor`, `lextothex`,
`cmatthewbell`) with `all: ["**"]` (full access) and an empty `"*"` baseline.

**Why:** new files are new surface and new placement decisions; making every
operation an explicit, reviewable grant keeps that surface deliberate.

### Agent workflow — do this before opening a PR

An autonomous agent (or a human) can follow this checklist deterministically:

1. **Determine the pushing actor's login** — the GitHub identity performing
   *this* push (this is what the gate reads as `PR_AUTHOR`: `github.actor`, not
   the PR's original opener). If a maintainer pushes a fix onto someone else's
   PR, that push is checked against the maintainer's own grants.
2. **Confirm that login has an entry** in `.github/file-permissions.json` (or is
   covered by a non-empty `"*"` baseline). If it has neither, it is **fully
   blocked — it cannot even edit** — and an admin must add it first.
3. **For every file you intend to add/edit/delete**, confirm the author's grant
   for that **operation** matches the path (remember: a rename needs `delete` of
   the old path **and** `create` of the new).
4. **Run the gate locally** and ensure it exits `0` before pushing:

   ```bash
   PR_AUTHOR=<login> BASE_REF=origin/main bun run check:contribution
   ```

5. **If blocked**, either place the change where the author **is** permitted, or
   ask an admin to add/extend a grant in `.github/file-permissions.json` (that
   file is itself **admin-only** to edit). **Do not** work around the gate.

### External-actor changes — reviewer no-cheating checklist

For any PR that claims to move an onboarding candidate, swarm member, or
analytics/research producer onto the external-actor rail
([D25](docs/decisions.md#d25--external-actor-rail-for-simulated-independent-entities)),
the reviewer must verify every item in the diff and its executed test evidence:

- [ ] One private container/filesystem represents each actor; no shared home,
  state database, keystore, or host-process fallback remains on the converted
  path.
- [ ] The container inherits no ambient host environment. Every injected secret
  is explicit, redacted, and scoped to that actor; admin credentials never
  substitute for member or analytics-provider roles.
- [ ] The harness does not fetch context, author, repair, sign, submit, or
  compute provider output for the actor. Private keys remain actor-held, and an
  admitted member keeps the same identity across later sessions.
- [ ] The claimed boundary is crossed through real REST calls with no direct DB
  write or privileged shortcut; a producer POSTs already-computed data rather
  than triggering computation in the consumer/API process.
- [ ] Missing resources and actor failures are loud, at least one real actor
  execution is asserted in the existing CI gates, and no mock, skip, template,
  or inference-off mode can make the behavior green. Extend an existing gate;
  do not add a workflow solely for this review bar.

### Sensitive surfaces are protected implicitly

Because the dictionary is deny-by-default, `contract/`,
`backend/**/migrations/`, `.github/`, `docs/`, and
`scripts/check-contribution.ts` are only touchable by logins **explicitly
granted** those globs — today, the three admins. There is no separate
owner-review mechanism guarding them; the grant list **is** the guard.

### How it is enforced (and the honest limits)

- `scripts/check-contribution.ts` runs in the `docs-lint` job on every PR. It is
  **diff-scoped** (only the paths changed in this PR's range are examined),
  **actor-aware** (it reads `PR_AUTHOR` = `github.actor`, the identity that
  pushed the commits this run is checking — not the PR's original opener), and
  **deny-by-default**: it classifies each changed path as a create/edit/delete
  and blocks any operation the actor is not granted in
  `.github/file-permissions.json`. It also flags roadmap task-lists added
  under `docs/`. Run it locally with `bun run check:contribution`.
- The dictionary itself is always read from the **merge-base** (the base
  branch's already-committed version), never from the PR's own `HEAD` — a PR
  editing `.github/file-permissions.json` to grant itself more access cannot
  make that self-grant apply to its own diff. The edit is checked against the
  pre-existing policy like anything else, and only takes effect once merged.
- **Enforcement reality on this repo:** the gate is only a **CI check**. On this
  private/free plan there is **no branch protection**, so a human clicking
  *Merge* on GitHub can bypass a red check. The real enforcement is that merges
  go through the **automated loop / merge tooling**, which refuses to merge
  unless all checks are green — not the GitHub merge button.
- Judgment calls (is a new file justified, is this a decision that belongs
  upstream, is the PR one concern) are for the PR reviewer. NOTE: a follow-up
  will add an automated reviewer agent for these; for now they are human-reviewed.

## Where things are documented

- Documentation map and canonical-vs-supporting ownership: [`docs/architecture.md`](docs/architecture.md)
- Preview mode (wrapper, goldens, drift gate, hosted Cloudflare Pages): [`docs/architecture.md`](docs/architecture.md) §4
- Overall architecture: [`docs/architecture.md`](docs/architecture.md)
- Full-stack demo: [`docs/architecture.md`](docs/architecture.md)
- Design decisions (D14: why preview mode replaced the "frozen" bundle; D19/D20: hosted preview URLs via Cloudflare Git integration): [`docs/decisions.md`](docs/decisions.md)
- Live-data endpoint contract (buybacks / token metrics / sleeves / framework DTOs + provenance rules): [`docs/architecture.md`](docs/architecture.md)
- Infra/domain map (D13): [`docs/architecture.md`](docs/architecture.md)
- Deployment & credentials (GitOps): [`docs/runbooks/deployment.md`](docs/runbooks/deployment.md)
