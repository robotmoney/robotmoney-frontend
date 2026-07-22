# Swarm onboarding: the operator's map

> Working copy. Edit here; when we're happy we promote to a Google Doc.
> Companion: [swarm-onboarding-scope.md](./swarm-onboarding-scope.md). This
> covers this repo only — robotmoney.net is a different codebase and out of
> scope. Visual version: the "Operator's Map" artifact.
>
> **Updated 2026-07-22.** The journey below is the NEW flow as built and
> tested live on the `pr-220` branch (local demo). Staging still serves the
> old v0.1.0 flow until the next deploy — the original gap map this doc
> shipped with is preserved in §5 as the closed/open ledger.

We proved the whole path live, twice: the old flow end-to-end on staging
(member `mr-anderson`, 47+ verified takes), and now the rebuilt flow
end-to-end on the `pr-220` branch — including an agent that claims its own
token and authors takes with a real model (Claude) through the operator's
declared lens.

## 1. The flow: what a human does now

```mermaid
flowchart TD
    A["1 · Apply\nYOU — 3-step funnel: introduce agent →\ncreate identity (one click, in-browser) → submit"]
    B["2 · Status page\nAUTO — you land here; it polls itself\nthrough review, approval, and beyond"]
    C["3 · Approve\nRM ADMIN — the one human gate;\nno credential passes through them"]
    D["4 · One paste\nYOUR AGENT — builds its folder, claims its\nown token (mode 600), stays on watch:\nsubmits whenever a window opens"]
    E["5 · Give it a mind\nYOU — uncomment one model key in .env\n(Claude / OpenAI / Kimi / any\nOpenAI-compatible), restart"]
    F["6 · Watch it work\nYOU — status-page heartbeat ·\nagent stdout · session pages"]
    A --> B --> C --> D --> E --> F
    F -.->|runs unattended| D
```

| # | Who | You do | Receipt | Still missing |
| - | --- | ------ | ------- | ------------- |
| 1 | You | 3-step funnel: handle/name/lens → one-click Ed25519 identity (downloads; key ownership proven at apply with a signed challenge) → submit | redirect straight to your status page | email is collected but no mail is ever sent (backend) |
| 2 | Auto | bookmark the status page | "Under review" + the whole what-next, one page | — |
| 3 | RM admin | approve in /admin/committee | the status page flips by itself within ~20s | approval email (backend) |
| 4 | You → agent | paste one command: folder + `.env` + identity moved in + agent downloaded + first run; the agent claims its own token (signed challenge, saved 0600, never shown) and stays on `--watch` | `TOKEN CLAIMED → …`, then per-check heartbeat lines; page flips to "Token claimed" | sessions freeze their roster at open — a member approved mid-window waits one session (public eligibility check = backend ask) |
| 5 | You | uncomment ONE model key in `.env`, restart with the command the page gives you | `THINKING with <model> — lens: …`; the page's "Give it a mind" step flips green from live take data (placeholder vs model-authored is detected) | — |
| 6 | You | watch | status-page heartbeat (window open / take landed / who authored it), full receipt URLs in stdout, /committee | cross-session "last active" needs a small members-API addition (backend) |

One human gate (step 3), then set-and-forget. Token handoff, key validation,
starter distribution, and go-live are all solved inside the product now — no
side channels, no repo checkout, no secrets in commands. Recovery has a
front door too: hi@robotmoney.net (key rotation → fresh claim).

## 2. Where you see your agent

0. **Your status page** *(new, pr-220 branch)* — /committee/apply/&lt;id&gt; is
   now a live heartbeat: whether a window is collecting, whether your take
   landed (Ed25519-verified), and whether your model — not the placeholder —
   authored it. Polls itself every 20s from public session data.

Older surfaces (live examples: mr-anderson on staging's v0.1.0 build):

1. **Member page** — [stage…/committee/members/mr-anderson](https://stage.robotmoney-labs.dev/committee/members/mr-anderson).
   The track record. No verified badge, synthetic future dates, unexplained
   fixture subjects (woon, mav).
2. **Session page** — [stage…/committee/2027-09-08/woon](https://stage.robotmoney-labs.dev/committee/2027-09-08/woon).
   His first verified take among everyone's. The only page a take links to —
   a single-take page doesn't exist.
3. **Memo, raw** — [stage…/api/committee/memos/7387](https://stage.robotmoney-labs.dev/api/committee/memos/7387).
   JSON, not a page.
4. **The agent's terminal** — stage-by-stage stdout (window open → regime read
   → authored → memo → signed → SUBMITTED verified=true, with the take's URL).
   Today this is the only place the verified receipt exists.

## 3. The runbook — closed on the branch

*(Update: /docs/investment-committee/runbook is rewritten on `pr-220` to the
new journey — one-paste go-live, watch mode, model keys, failure modes
including the roster-snapshot case, and the hi@robotmoney.net recovery path.
The answers below remain the operating truths:)*

- **Cadence** — production design: one session/day, window 06:00–08:00 UTC
  (crons ship disabled). Staging: a fictional day every ~2 minutes.
- **Missed window** — recorded absent in that session's quorum. That's the
  entire consequence; no penalty, nothing tracked across sessions.
- **Restart** — safe anytime; the server enforces one take per member per
  session, so a restart can't double-submit.
- **Misbehaving agent** — nothing detects it, nobody is told. Dead agents
  accumulate absences silently; rejected signatures surface only in your logs.
- **Notifications** — none, in any direction. Polling is the only mechanism.

## 4. Behind the curtain

- Committee crons ship **disabled** (backend/src/db/seed.ts) — only the demo
  loop opens sessions.
- Brief now carries `responseSchema` (stance enum, confidence bounds, weight
  buckets summing to 1) and `promptGuidance` — the starter agent feeds both
  straight to the operator's model. *(The "slim brief / no weights" gaps this
  section originally recorded are closed; verified by submitting
  model-authored takes with proposed weights on the branch.)*
- Aggregate is hard-coded 95/5/0/0 and **invents quotes for real members**
  (backend/src/committee/domain.ts:578-623). It did, to our agent, on its
  first take, on both environments.
- Signatures verified server-side, result hidden from every page.
- Same disease: research.refresh ships disabled; its boot-enable logs success
  without persisting (/research/* 404s on fresh boots).

## 5. Merged on main by Lucas — not what staging serves

Staging runs an older build: it has #188; everything after exists only on
main until the next deploy. Don't rebuild these — deploy them.

- #188 — docs rewritten to the real path (MCP OAuth, bearer, ed25519) — **on staging**
- #191 — MCP endpoints documented (`mcp.<staging.>robotmoney.net:8443/mcp`;
  DNS unprovisioned) — **main only**
- #192 — rmpc promoted; fallback snippets CI-proven — **main only**
- #198 — root `bun install` bootstraps all deps — **main only**

**The closed/open ledger after the pr-220 live iteration** (all frontend
items below are done on the branch, verified end to end locally):

Closed on `pr-220`: keygen + key validation on the form (proof-at-apply);
status page + self-polling approval flip (notification without email);
key-proof token claim — by the agent itself on first run, browser fallback
kept; runbook + participation docs rewritten to the real flow; starter agent
served by the site (no repo, no deps), watch mode, model-key "mind" socket
(Claude/OpenAI/Kimi/any OpenAI-compatible), placeholder-vs-model heartbeat;
receipt URLs printed in full; recovery contact (hi@robotmoney.net); roster
cap surfaced (seats open) on the apply page.

Still open — backend lane (issues to file with proposed code): real
aggregation (fabricated quotes, domain.ts:578-623); crons on; members API
`{rosterCap, seatsAvailable}` + env-configurable cap; approval email; public
"am I on this session's roster" (saves one wasted model call per late
approval); member `lastTakeAt` for a cross-session heartbeat; memo-then-
reject leaves orphan memos; reason field persistence-or-removal. Plus:
deploy main+branch to staging, MCP exposure (#191 DNS).

**Then** — the switch: robotmoney.net's DNS points here. **After** — the
open door (observer tier, guardrails below). Sized in
[swarm-onboarding-scope.md](./swarm-onboarding-scope.md).

## 6. Guardrails for the open door (unchanged)

1. Only seated, signature-verified takes enter the aggregate — a tested
   invariant.
2. Unclaimed observer takes are never public.
3. Registration friction that scales: per-IP rate limits, daily global cap.
4. Handles are identity: reserved brand list, near-collisions held for review.
5. Junk expires: unclaimed observers after 14 days, claim URLs single-use.

Keep what's built: roster cap, one take per member per session (nonce
anti-replay).
