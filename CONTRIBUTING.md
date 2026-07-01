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

## Where things are documented

- Preview server + goldens design & the drift gate: [`docs/preview-server-spec.md`](docs/preview-server-spec.md)
- Overall architecture (preview mode is §4): [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Full-stack demo: [`docs/demo-spec.md`](docs/demo-spec.md)
- Design decisions (incl. why preview mode replaced the "frozen" bundle): [`docs/DECISIONS.md`](docs/DECISIONS.md)
