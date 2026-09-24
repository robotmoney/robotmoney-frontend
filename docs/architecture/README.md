# Architecture

> **Document authority.** This document summarizes the system and its product
> invariants. Two reviewed specifications govern the details and win where this
> document conflicts with them:
>
> - [System scheduler spec](../technical/system-scheduler-spec.md) — session
>   lifecycle, timing, epochs, event stream, recovery, and scheduler acceptance
>   gates (its §10).
> - [Smoke production spec](../technical/smoke-production-spec.md) — deployment,
>   credentials, participants, readiness, and deployment acceptance gates (its
>   §10). Adopted 2026-09-22 under [D47](../decisions.md#d47); not yet shipped.
>
> Passages here that describe scheduling, deployment, credentials or
> participants are short summaries with a link to the governing section. Where
> a passage describes the worker or smoke code as it exists, it is marked as
> legacy implementation. Adoption of either spec is not evidence that the
> implementation has shipped.
> [Release policy](../technical/release-runbooks.md) continues to govern release gates.

Robot Money frontend + analytics backend. A clean rewrite of robotmoney.net that
drops React/Next.js in favor of a **buildless, browser-native** stack, with a
small HTTP API and a Postgres-backed task queue, self-hosted on DigitalOcean — a
single `docker-compose` box for CI/smoke, and a tiered topology (DO compute+storage,
Cloudflare for DNS+observability) in production (see the
[network topology section](network-topology.md#network-topology--dns-origins--vendors)).

For the *why* behind each choice, see [decisions.md](../decisions.md).

---

## 1. Goals & scope

- **Preserve the marketing UI** of robotmoney.net (reproduce the look exactly).
- **Cherry-pick two feature areas**: the **regime/research** data views (the
  regime classifier + its regime-family research signals) and the **Investment
  Swarm**. Allocation / vault / wallet dashboards are out of scope, **except**
  the `/allocation` page's vault-economics slice (TVL, share price, adapters,
  7-day APY), brought into scope by a live Base RPC pipeline — see
  [decisions.md §D15](../decisions.md#d15--live-vault-economics-pipeline-from-base-rpc-supersedes-d1s-vault-dashboard-exclusion)
  and §10 below — **and** the prop-wallet valuation feed (live holdings +
  history behind `GET /api/dashboards/wallet-balances`), brought into scope the
  same way — see
  [decisions.md §D16](../decisions.md#d16--live-wallet-balances-pipeline-from-base-rpc-supersedes-d1s-wallet-dashboard-exclusion)
  and §10 below. Buybacks — the last static remnant of that line — were brought
  into scope by
  [decisions.md §D17](../decisions.md#d17--remove-the-last-baked-frontend-data-live-buybacks-token-metrics-sleeves-supersedes-d1s-remaining-exclusions):
  `GET /api/dashboards/buybacks` is served live from ROBOTMONEY Transfer logs
  (`backend/src/chain/buyback-logs.ts`, refreshed by the `buybacks.refresh`
  worker job). Nothing of the original out-of-scope line remains a static port.
- **No build step.** No bundler, transpiler, or compiler — the browser does all
  the work at runtime; only evergreen browsers are supported.
- **Consolidate backends onto one Postgres** (Docker for CI/smoke; a DO Managed
  Postgres HA cluster in production — see the topology's
  [data tier section](network-topology.md#7-data-tier--postgres-ha-cluster-do)).
- **Rebuild the data pipeline** as a custom Postgres-backed task queue (replacing
  the old GitHub Actions cron + Node scripts).
- **Clean frontend/backend separation** — one repo now, designed to split into
  two later with zero source edits.

Out of scope for v1: the allocation / vault / wallet dashboards, the generative-art
visualizations, blog/media editorial, and other secondary pages — **except** the
live vault-economics slice of `/allocation` (§D15), the live prop-wallet
valuation feed (§D16), and the live buyback / token-metrics / wallet-sleeves
feeds that retired the last baked literals (§D17).

---

## 2. The buildless principle

The defining constraint: **no ahead-of-time transpile, compile, or bundle.**

Allowed (browser-native or runtime-only): `<script type="module">`, import maps,
prebuilt library files from a CDN, and Bun's native TypeScript execution on the
backend (Bun runs `.ts` directly at startup, no build artifact).

Forbidden: webpack/vite/rollup, JSX, framework SFC compilation, a TypeScript build
step, and a Tailwind compile step.

Consequences that shape everything below: the frontend is plain HTML + CSS + JS;
styling is hand-written CSS (no Tailwind); the component layer is Alpine.js loaded
as a global script; the backend runs `.ts` files directly via Bun. **All
server-side components run on Bun.**

---

## Sections

| File | Contents (former `docs/architecture.md` headings) |
|---|---|
| [Repository layout](repository-layout.md) | 3. Repository layout (split-ready) |
| [Frontend](frontend.md) | 4. Frontend |
| [Backend](backend.md) | 5. Backend |
| [Data model](data-model.md) | 6. Data model |
| [Task queue and workers](task-queue-and-workers.md) | 7. Task queue & workers; 11. Task queue topology; 12. Analytics pipeline — producer executions |
| [Deployment](deployment.md) | 8. Deployment; Smoke deployment |
| [Investment Swarm](investment-swarm.md) | 9. Investment Swarm (feature architecture) |
| [Vault economics and wallet balances](vault-and-wallet.md) | 10. Vault economics & wallet balances (live chain data) |
| [Projects directory](projects-directory.md) | 11. Projects directory (agentic-economy analytics) |
| [Configuration delivery](configuration-delivery.md) | 12. Configuration delivery — the compose allowlist rail |
| [Dashboards live-data contract](dashboards-live-data.md) | Live-data contract — 4 new dashboard endpoints; Config the implementers consume (already shipped by this worker in `config.ts`); 1. Token buybacks — `GET /api/dashboards/buybacks`; 2. Token metrics — `GET /api/dashboards/token-metrics`; 3. Wallet sleeves — `GET /api/dashboards/wallet-sleeves`; 4. Allocation framework — `GET /api/dashboards/allocation`; Migration + goldens checklist for implementers |
| [Member onboarding](member-onboarding.md) | 11. Member onboarding (normative spec) |
| [Admin Surface: Research and Investment Swarm](admin-surface.md) | Admin Surface: Research and Investment Swarm; 1. Outcome; 2. Settled scope for this surface; 3. Current product baseline; 4. User stories and required behavior; 5. Database migration; 6. Backend implementation; 7. Frontend implementation; 8. Verification; 9. Delivery order; 10. Definition of done |
| [Network topology](network-topology.md) | Network topology — DNS, origins & vendors; 1. Principle — two separations of concern; 2. The vendor split; 3. The surfaces — subdomain map; 4. DNS & TLS — how each hostname resolves; 5. Static tier — marketing (DO Spaces CDN); 6. API tier — services on DO droplets; 7. Data tier — Postgres HA cluster (DO); 8. No double-CDN; 9. Seamless without a single origin, and observability; 10. Relationship to existing decisions |

## Documentation map

The `docs/` directory holds the repository's durable technical documentation.
The GitHub Plan issue is the canonical execution queue; do not add mutable
roadmaps, task checklists, or phase ordering to `docs/`.

## Canonical documents

- [Architecture](../architecture.md) — product and system boundaries, runtime
  components, data flow, and the D13 network topology.
- [Decisions](../decisions.md) — accepted decision records; D47 owns deployment
  mechanism authority, D48 records the judge-mode product decision, D51 the
  final-take rule, and D52 the credential, scope and epoch-grid decisions.
- [System scheduler spec](../technical/system-scheduler-spec.md) — session
  lifecycle, epoch timing, the API event stream, recovery after downtime, and
  the scheduler acceptance gates. Prescriptive; not yet shipped.
- [Smoke production spec](../technical/smoke-production-spec.md) — sole adopted
  deployment design: deployment lifecycle, credentials, participants,
  readiness, and the deployment acceptance gates. Approved for implementation
  but not yet shipped.
- [Release-runbook policy](../technical/release-runbooks.md) — gates, phases,
  evidence, and approval for future releases.
- [Credential doctor](../runbooks/credential-doctor.md) — legacy GitHub secret
  utility, not the adopted deployment credential path.
- [Bot-analytics UI port plan](../bot-analytics-ui-port-plan.md) — the canonical
  spec for the Analytics Surface dashboard port (issues #379-#402 and
  siblings), with its companion
  [original-app](../bot-analytics-ui-port/inventory-original.md) and
  [current-repo](../bot-analytics-ui-port/inventory-current.md) inventories.

## Reviews and investigations

Point-in-time review artifacts live under [`code-review/`](../code-review/).
Resolved debugging notes live under [`archive/`](../archive/), with their
original dates and findings preserved. Archived material is evidence, not a
statement of current behavior; update the canonical document when a finding
changes a system commitment.
