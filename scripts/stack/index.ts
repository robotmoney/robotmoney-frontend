// scripts/stack/ — the SHARED compose lifecycle (docs/architecture.md §3 L2,
// §11.3 E5; docs/decisions.md D22/D23). One bring-up with a `core` (postgres +
// api) and a `full` (+ the three worker lanes) profile, consumed by the demo,
// by the inference-off rails check, and by the onboarding eval.
//
// Three invariants hold across every file in this directory:
//   1. No module-scope side effects — importing this boots nothing.
//   2. No access to the process environment — every input is explicit, and a
//      compose child inherits only allowlisted docker-client plumbing.
//   3. No inference-off, injection, or conditional-skip affordance on any path
//      this module serves; a missing Docker daemon throws.
export * from "./config.ts";
export * from "./ports.ts";
export * from "./stack.ts";
