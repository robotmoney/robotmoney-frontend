# Deployment

Part of the [architecture](README.md). Split out of the former single `docs/architecture.md` on 2026-09-23; section numbering inside is unchanged so old citations still resolve.

## 8. Deployment

The [smoke production spec](../technical/smoke-production-spec.md) is the sole
adopted deployment design and is not yet shipped. This section records component
boundaries and the separate D13 network-topology decision; it does not provide
deployment commands, credential setup, or an alternative smoke lifecycle.
Use [release policy](../technical/release-runbooks.md) for release gates and
create an exact-SHA runbook when a release is scheduled and the required tools
exist.

The repository's Compose topology contains Postgres, API, static web server,
the analytics and research worker lanes (§7), and `system-scheduler` (API
credential only), which replaced `worker-swarm`. Standing participant
containers are defined by the credential file. The adopted design owns how those
services are prepared, checked, replaced and kept running. Its credentials and
target identity rules are in smoke-production-spec §§3–5; participants and
readiness are in §6 (scheduler health in
[§6.3](../technical/smoke-production-spec.md#63-sessions-are-independent));
preflight is §7; production initialization, boot and migration are
[§8.5](../technical/smoke-production-spec.md#85---migrate-and-production-upgrades)
and [§9](../technical/smoke-production-spec.md#9-production). Production
migration is a separate operator step, never part of a boot.

The production DNS, vendor and service placement recorded by D13 is described
under [Network topology](network-topology.md#network-topology--dns-origins--vendors). That decision
does not change the adopted deployment mechanism. D13 is the accepted target
topology, not evidence that the current host matches it; verify deployed state at
the release commit.

**Preview mode** is a development surface backed by checked-in API goldens. Use
the local preview instructions in §4 and [CONTRIBUTING.md](../../CONTRIBUTING.md)
for the current workflow. Preview hosting does not determine production
deployment behavior.

## Smoke deployment

[Smoke production spec](../technical/smoke-production-spec.md) is the sole adopted
deployment design. It is approved for implementation and has not shipped; the
runtime implementation remains determined by the exact code being run.
[Release policy](../technical/release-runbooks.md) owns release gates, phases,
evidence and approval. This architecture document does not restate deployment
commands or mechanisms.

Product behavior for sessions, judging, analytics, and member onboarding is
specified in §§9 and 11 and their linked contracts. Do not infer participant
or scheduler deployment behavior from those product descriptions; use the
adopted smoke spec.
