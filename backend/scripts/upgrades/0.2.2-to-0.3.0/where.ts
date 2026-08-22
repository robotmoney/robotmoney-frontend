// `bun run rollout:where` — the v0.3.0 rollout's position probe.
//
// Answers, in one screen: which host am I on and what can it do, which commit
// and rc am I at, which steps are done, which of those still COUNT, and what
// is the next command. Read docs/runbooks/rollout-procedure.md §1 first — this
// script is that section's implementation.
//
// It asserts nothing it cannot derive. Host role comes from the filesystem,
// release identity from git, and step completion from receipts that are
// re-verified against both before they are believed. Nothing here reads a
// human-maintained status field, because this repo has already proved twice
// (the v0.2.2 runbook's two dead status paragraphs) that such a field is wrong within a day.
//
// SIDE-EFFECT FREE by default: no database connection, no network, no docker.
//
// The probe itself is backend/scripts/lib/rollout-where.ts, shared with every
// other release. This file is the release half of it and nothing else: which
// manifest, which tags, which tracking issue, and where the repo root is.
//
// Usage:
//   bun scripts/upgrades/0.2.2-to-0.3.0/where.ts                  # print state
//   bun scripts/upgrades/0.2.2-to-0.3.0/where.ts --json           # same, machine-readable
//   bun scripts/upgrades/0.2.2-to-0.3.0/where.ts --record <step> [--note "..."]
//
// Exit codes: 0 = printed (any state), 2 = could not run (bad step id, no git).

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mainWhere } from "../../lib/rollout-where.ts";
import { STEPS, TAG_GLOB, TRACKING_ISSUE } from "./steps.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
// backend/scripts/upgrades/0.2.2-to-0.3.0/ -> <repo root>
const repoRoot = join(scriptDir, "..", "..", "..", "..");

if (import.meta.url === `file://${process.argv[1]}`) {
  mainWhere({ repoRoot, steps: STEPS, tagGlob: TAG_GLOB, trackingIssue: TRACKING_ISSUE });
}
