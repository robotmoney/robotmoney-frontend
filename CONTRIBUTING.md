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

- `bun run preview` serves the **live** `frontend/public` (edits show on refresh)
  and **mocks every `/api/*` route** from committed goldens
  (`goldens/api-goldens.json`). No backend needed.
- It binds a **random free port** each run (printed on start), so several previews
  can run at once without colliding. Pin one with `PORT=8080 bun run preview`.

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

Goldens are mock API responses the preview server replays. **Correct goldens are
the responsibility of the change author** — there is no nightly job that fixes
them for you, and a CI **drift gate** will block a PR whose goldens no longer
match the code.

Goldens must be **captured from a real running system** — never hand-edited,
never derived from other fixtures — so their **field shapes** match what the
backend actually returns:

```bash
# Against a local full stack:
bun run demo                                             # brings up real backend + analytics
BACKEND_URL=http://127.0.0.1:48787 bun run goldens:update
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
  scheduled recomputes, committee sessions), run the full stack:

  ```bash
  bun run demo         # see docs/demo-spec.md — much better data simulations
  bun run demo:status
  bun run demo:down
  ```

- The demo is the right surface for validating anything **data-dependent**;
  preview is the right surface for iterating quickly on the **marketing surface**
  itself.

## Where changes go (and who can add files)

This repo holds the **implementation** of the site + analytics backend. Where a
file goes — and whether you may add one at all — is governed below and enforced
on every PR by `scripts/check-contribution.ts` plus `.github/CODEOWNERS`.

### Placement map

| Kind of change | Location |
| --- | --- |
| Site UI | `frontend/public/` — `views/`, `assets/css/`, `assets/js/app/`, `assets/` |
| Server / queue / workers / migrations | `backend/` |
| Shared HTTP contract | `contract/` — re-vendor with `bun run sync-contract`, never hand-edit |
| Committee MCP server | `mcp/` |
| Tooling & CI scripts | `scripts/` — tests in `scripts/tests/` |
| Technical docs about this repo | `docs/*.md` — kebab-case |
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

### Who can add files (the create-gate)

- **Casual contributors** (anyone not listed in `.github/CODEOWNERS`): EDIT any
  existing file freely, and you may CREATE only test files (`*.test.ts`,
  `*.spec.ts`, or files under a `tests/`/`test/` directory). Any other new file
  needs a codeowner — as the author, or approving the PR. If you need a new doc,
  view, migration, workflow, or top-level directory, ask a codeowner
  (`@LextotheX`, `@cmatthewbell`, `@lucky-tensor`).
- **Codeowners** may create files anywhere.
- **Why:** new files are new surface and new placement decisions; the PR that
  motivated this rule added eleven, several in the wrong repo.

### How it is enforced

- `.github/CODEOWNERS` requires owner review on the sensitive paths (with branch
  protection "Require review from Code Owners").
- `scripts/check-contribution.ts` runs in the `docs-lint` job on every PR:
  author-aware, it blocks a non-owner from creating files outside the allowlist
  and flags roadmap task-lists added under `docs/`. Run it locally with
  `bun run check:contribution`.
- Judgment calls (is a new file justified, is this a decision that belongs
  upstream, is the PR one concern) are for the PR reviewer. NOTE: a follow-up
  will add an automated reviewer agent for these; for now they are human-reviewed.

## Where things are documented

- Preview server + goldens design & the drift gate: [`docs/preview-server-spec.md`](docs/preview-server-spec.md)
- Overall architecture (preview mode is §4): [`docs/architecture.md`](docs/architecture.md)
- Full-stack demo: [`docs/demo-spec.md`](docs/demo-spec.md)
- Design decisions (incl. why preview mode replaced the "frozen" bundle): [`docs/decisions.md`](docs/decisions.md)
- Live-data endpoint contract (buybacks / token metrics / sleeves / framework DTOs + provenance rules): [`docs/contract-live-data.md`](docs/contract-live-data.md)
- Infra/domain map (D13): [`docs/topology.md`](docs/topology.md)
- Deployment & credentials (GitOps): [`docs/deployment.md`](docs/deployment.md)
