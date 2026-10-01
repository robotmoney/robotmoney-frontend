import { APP_CODE, RESTORE_CODE, postflightCode, preflightCode } from "../../lib/rollout-manifest.ts";
import type { RolloutStep } from "../../lib/rollout-manifest.ts";
import { TAG_GLOB } from "./release.ts";

const DIR = "0.4.0-to-0.5.0";
export { TAG_GLOB };

// P6.rc-tag files AFTER P4/P5, not before them (release-runbooks.md §3,
// revised for this release): the RC tag is cut only once stage preflight AND
// rehearsal both pass, not at "the tip you intend to ship" before either has
// run. That reverses the v0.2.1-precedented order every prior release used --
// see release-runbooks.md §3's own note on the change. `requires` on P6
// documents the dependency; `NEXT` (rollout-where.ts's "first not-ok step in
// manifest order") is what actually enforces it operationally, which is why
// P6 is positioned here in the array and not merely annotated in place of P2.
export const STEPS: RolloutStep[] = [
  {
    id: "P3.backup", phase: "P3 backup", section: "§4.2", title: "encrypted replica dump captured",
    hostRole: "stage", actor: "agent", requires: [], dependsOn: [],
    artifacts: ["rm-preupgrade-<STAMP>.dump.gpg", "rm-globals-<STAMP>.sql.gpg"], ttlHours: 48,
    verify: "bun run smoke:capture",
  },
  {
    id: "P3.gate-c", phase: "P3 backup", section: "§4.2", title: "dump restores and matches the v0.4.0 schema",
    hostRole: "stage", actor: "script", requires: ["P3.backup"],
    dependsOn: [...preflightCode(DIR), ...RESTORE_CODE, `backend/scripts/upgrades/${DIR}/restore-check.ts`], ttlHours: 48,
    verify: `bun backend/scripts/upgrades/${DIR}/restore-check.ts $RM_BACKUP_DIR --emit-receipt`,
  },
  {
    id: "P4.preflight-live", phase: "P4 preflight", section: "§4.4", title: "live v0.4.0 database is safe to migrate",
    hostRole: "stage", actor: "script", requires: ["P3.gate-c"], dependsOn: preflightCode(DIR), ttlHours: 2,
    verify: `bun backend/scripts/upgrades/${DIR}/preflight.ts --emit-receipt`,
  },
  {
    id: "P5.rehearsal", phase: "P5 rehearsal", section: "§5", title: "RC migrates and postflight passes on the smoke-twin",
    hostRole: "stage", actor: "script", requires: ["P3.gate-c"], dependsOn: [...APP_CODE, `backend/scripts/upgrades/${DIR}/stage-rehearsal.ts`], ttlHours: 48,
    verify: `bun backend/scripts/upgrades/${DIR}/stage-rehearsal.ts $RM_BACKUP_DIR --emit-receipt`,
  },
  {
    id: "P6.rc-tag", phase: "P6 release identity", section: "§5.1",
    title: "an RC tag points at HEAD, cut only after stage preflight+rehearsal pass",
    hostRole: "any", actor: "operator", requires: ["P4.preflight-live", "P5.rehearsal"], dependsOn: [], derived: true,
    verify: "git tag --points-at HEAD -l 'v0.5.0-rc.*'",
  },
  {
    id: "P8.postflight-prod", phase: "P8 verify", section: "§7", title: "production schema and boot invariants are clean",
    hostRole: "cutover", actor: "script", requires: ["P4.preflight-live", "P5.rehearsal", "P6.rc-tag"],
    dependsOn: postflightCode(DIR, ["scripts/lib/contract-freshness.ts", "scripts/prerender.ts", "package.json"]), ttlHours: 2,
    verify: `bun backend/scripts/upgrades/${DIR}/postflight.ts --emit-receipt=P8.postflight-prod`,
  },
  {
    id: "P8.verify-prod", phase: "P8 verify", section: "§7",
    title: "the live product satisfies its invariants",
    hostRole: "cutover", actor: "script", requires: ["P8.postflight-prod"],
    dependsOn: [
      "scripts/verify-live.ts",
      "scripts/lib/verify/**",
      "backend/scripts/lib/checks.ts",
      "backend/scripts/lib/rollout-receipt.ts",
    ],
    ttlHours: 2,
    verify: "bun run verify:live --tier readonly --emit-receipt=P8.verify-prod",
  },
];
