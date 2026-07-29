// scripts/stack/ — the SHARED compose lifecycle (docs/architecture.md §3 L2,
// §11.3 E5; docs/decisions.md D22/D23). One bring-up with a `core` (postgres +
// api) and a `full` (+ the three worker lanes) profile. The demo
// (scripts/lib/demo-main.ts, `full`) is its runtime consumer today; the
// onboarding eval and the inference-off rails check adopt `core` next, and the
// profile split exists so they can, without a second bring-up.
//
// Three invariants hold across every file in this directory:
//   1. No module-scope side effects — importing this boots nothing.
//   2. No access to the process environment — every input is explicit, and a
//      compose child inherits only allowlisted docker-client plumbing. The one
//      deliberate exception is `host-env.ts`, whose single export returns the
//      ALLOWLISTED docker-client plumbing and provably nothing else (no key, no
//      token, no model knob can pass the filter) — it exists so a caller that
//      must not read the environment itself (the keyless eval, D22 rule 1) can
//      still find a Docker daemon.
//   3. No inference-off, injection, or conditional-skip affordance on any path
//      this module serves; a missing Docker daemon throws.
export * from "./config.ts";
export * from "./host-env.ts";
// naming.ts computes the environment-scoped compose project / container name
// prefix and the labels every spawner stamps, so a leaked container is
// attributable to the environment that made it (CI job vs local shell) and can
// be reaped by LABEL rather than by name substring.
export * from "./naming.ts";
// ports.ts DISCOVERS host ports; it does not choose them. There is deliberately
// no allocator export left (`allocatePorts`/`stackPortRequests` were deleted):
// the compose files publish container ports only, Docker binds the host side
// atomically, and this module reads back what it chose. A surviving "pick a
// free port" helper would only invite the TOCTOU race back in.
export * from "./ports.ts";
export * from "./stack.ts";
