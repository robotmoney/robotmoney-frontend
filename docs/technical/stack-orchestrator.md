# `stack` orchestrator — field guide

> **DEPRECATED 2026-09-23 — historical field guide for an unadopted tool.**

Use [Smoke production spec](../technical/smoke-production-spec.md) for the
**sole adopted deployment design** (adopted 2026-09-22; approved for
implementation, not yet shipped). Its W1/W2/W3 workstreams and acceptance
gates replace deployment mechanisms described here.

The external `bozemanpass/stack` / Kubernetes mechanism is not used for current
deployment and is not an adopted migration path. It is unrelated to this
repository’s `scripts/stack/` Compose library, which the existing smoke tool uses.

[Release-runbook policy](../technical/release-runbooks.md) still governs
release gates, phases, evidence and approval. Adoption of a design does not
make its commands available in an older checkout; any operational procedure
must be verified against the exact deployed or release-candidate commit.

The [archived document](../archive/stack-orchestrator.md) is retained
for provenance only. It is not an active plan or a second source of requirements.
