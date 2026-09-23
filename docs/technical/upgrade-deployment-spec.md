# Upgrade deployment — the tool-separation specification

> **DEPRECATED 2026-09-23 — superseded deployment design.**

Use [Smoke production spec](../technical/smoke-production-spec.md) for the
**sole adopted deployment design** (adopted 2026-09-22; approved for
implementation, not yet shipped). Its W1/W2/W3 workstreams and acceptance
gates replace deployment mechanisms described here.

The entire former design/plan is retired as implementation authority, not just
its `rm_migrator` section. Do not implement its remaining phases, substitute
`rm_owner` into its commands, or use its sequencing as the current backlog.

[Release-runbook policy](../technical/release-runbooks.md) still governs
release gates, phases, evidence and approval. Adoption of a design does not
make its commands available in an older checkout; any operational procedure
must be verified against the exact deployed or release-candidate commit.

The [archived document](../archive/upgrade-deployment-spec.md) is retained
for provenance only. It is not an active plan or a second source of requirements.
